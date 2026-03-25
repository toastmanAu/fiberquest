'use strict'

/**
 * chain-store.js — On-chain tournament storage for FiberQuest
 *
 * Tournament lifecycle on CKB testnet:
 *
 *  1. ESCROW  — registration open, Fiber entry fees collected off-chain,
 *               player hashes recorded in cell data.
 *               Stays open until registrationDeadline.
 *
 *  2a. CANCELLED — min_players not met by deadline.
 *                  Agent returns entry fees via Fiber and consumes the cell.
 *
 *  2b. FUNDING  — min_players met. Escrow cell consumed, tournament funding
 *                 cell created. Prize pool tracked on-chain.
 *
 *  3. ACTIVE    — game in progress (RAM engine running).
 *
 *  4. SETTLING  — game ended, buffer period for result submission / finality.
 *
 *  5. COMPLETE  — winner paid via Fiber, cell consumed.
 *
 * Cell format:
 *   Lock:  organizer's secp256k1 (agent controls it)
 *   Type:  FiberQuest tournament type (CCC always-success, args = tournament ID)
 *          Enables global discovery by any agent scanning for this type script.
 *   Data:  0x46515458 (FQTX) | version (1 byte) | JSON payload
 *
 * Scanning: get_cells by type script code hash — finds ALL FiberQuest tournaments
 *           globally, across all organizer addresses, with no central registry.
 */

const MAGIC = Buffer.from('FQTX')
const VERSION = 1

// Minimum capacity: bytes × 1 Shannon/byte
const CKB_PER_BYTE = 100000000n // 1 CKB in Shannon

const SECP256K1_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8'

// CCC always-success type script — CKB VM v1, same code hash on mainnet + testnet.
// Used as the FiberQuest tournament type: any agent can scan for all tournaments
// globally by searching for this code hash with scriptType='type'.
// Source: CCC SDK https://github.com/ckb-ecofund/ccc
const ALWAYS_SUCCESS_CODE_HASH = '0x3b521cc4b552f109d092d8cc468a8048acb53c5952dbe769d2b2f9cf6e47f7f1'
const ALWAYS_SUCCESS_DEP_TESTNET = {
  txHash: '0xb4f171c9c9caf7401f54a8e56225ae21d95032150a87a4678eac3f66a3137b93',
  index: '0x0'
}
const ALWAYS_SUCCESS_DEP_MAINNET = {
  txHash: '0x10d63a996157d32c01078058000052674ca58d15f921bec7f1dcdac2160eb66b',
  index: '0x0'
}

// States
const STATE = {
  ESCROW:    'ESCROW',    // registration open
  CANCELLED: 'CANCELLED', // min not met — funds being returned
  FUNDING:   'FUNDING',   // min met, transitioning to active
  ACTIVE:    'ACTIVE',    // game in progress
  SETTLING:  'SETTLING',  // game ended, buffer period
  COMPLETE:  'COMPLETE'   // done, paid out
}

class ChainStore {
  constructor (opts = {}) {
    this.rpcUrl          = opts.rpcUrl  || process.env.CKB_RPC_URL || 'https://testnet.ckbapp.dev/'
    this.wallet          = opts.wallet  // AgentWallet instance
    this.isMainnet       = opts.isMainnet || false
    this.alwaysSuccessDep = this.isMainnet ? ALWAYS_SUCCESS_DEP_MAINNET : ALWAYS_SUCCESS_DEP_TESTNET
  }

  // FiberQuest tournament type script.
  // code_hash = CCC always-success (well-known, no custom binary needed).
  // args = tournament ID bytes — enables per-tournament lookup in addition to
  // global discovery (scan with empty args prefix to find all tournaments).
  _tournamentTypeScript (tournamentId) {
    return {
      codeHash: ALWAYS_SUCCESS_CODE_HASH,
      hashType: 'data1',
      args: '0x' + Buffer.from(tournamentId, 'utf8').toString('hex')
    }
  }

  // ── Encoding ──────────────────────────────────────────────────────────────

  encodeData (tournament) {
    const payload = {
      id:                   tournament.id,
      slug:                 tournament.id.split('_')[1] || tournament.id.slice(0, 8),
      state:                tournament.state,
      gameId:               tournament.gameId,
      modeId:               tournament.modeId,
      entryFee:             tournament.entryFee,       // CKB
      currency:             tournament.currency || 'Fibt',
      minPlayers:           tournament.minPlayers || 2,
      maxPlayers:           tournament.maxPlayers || 4,
      timeLimitMinutes:     tournament.timeLimitMinutes,
      registrationDeadline: tournament.registrationDeadline, // unix ms
      settlementBufferMs:   tournament.settlementBufferMs || 30000, // 30s default
      fiberPeerId:          tournament.fiberPeerId || '',
      fiberAddress:         tournament.fiberAddress || '',
      players:              tournament.players || [],  // [{name, paymentHash, paid}]
      prizePool:            tournament.prizePool || 0, // CKB
      winner:               tournament.winner || null,
      createdAt:            tournament.createdAt || Date.now(),
      tournamentMode:       tournament.tournamentMode || 'local',
      scoreSubmissions:     tournament.scoreSubmissions || null, // { playerId: { score, koCount, eventLogHash, submittedAt } }
      winnerInvoice:        tournament.winnerInvoice || null,    // Fiber invoice for losers to pay winner
      organizerAddress:     tournament.organizerAddress || null, // CKB address for player deposits (distributed)
      // Distributed tournament phase timestamps (all agents sync to these)
      startsAt:             tournament.startsAt || null,         // all agents start playing
      endsAt:               tournament.endsAt || null,           // all agents stop playing
      submissionDeadline:   tournament.submissionDeadline || null, // score cells must be on-chain by here
      resolvesAt:           tournament.resolvesAt || null,       // all agents resolve winner from chain data
    }
    const json = Buffer.from(JSON.stringify(payload))
    return '0x' + Buffer.concat([MAGIC, Buffer.from([VERSION]), json]).toString('hex')
  }

  decodeData (hexData) {
    if (!hexData || hexData === '0x') return null
    const buf = Buffer.from(hexData.slice(2), 'hex')
    if (buf.length < 6) return null
    if (!buf.slice(0, 4).equals(MAGIC)) return null
    try {
      return JSON.parse(buf.slice(5).toString())
    } catch {
      return null
    }
  }

  minCapacityShannons (hexData, tournamentId) {
    const dataBytes = BigInt((hexData.length - 2) / 2)
    const typeArgBytes = BigInt(Buffer.from(tournamentId || '', 'utf8').length)
    // 8 (capacity field) + 53 (secp256k1 lock) + 33 (type: code_hash + hash_type) + type args + data
    return (8n + 53n + 33n + typeArgBytes + dataBytes) * CKB_PER_BYTE
  }

  // ── RPC helpers ───────────────────────────────────────────────────────────

  async _rpc (method, params = []) {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    })
    const json = await res.json()
    if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`)
    return json.result
  }

  // ── Read operations ───────────────────────────────────────────────────────

  /**
   * Scan chain for all FiberQuest tournament cells globally.
   *
   * Searches by the FiberQuest tournament type script code hash — finds tournaments
   * from ALL organizer addresses with no central registry needed. Any FiberQuest
   * agent can discover all live tournaments this way.
   *
   * Client-side FQTX prefix check guards against false positives from other apps
   * that happen to use the same always-success type script.
   *
   * @param {string} [tournamentId] — optional: filter to a specific tournament by ID
   */
  async scanTournaments (tournamentId) {
    const args = tournamentId
      ? '0x' + Buffer.from(tournamentId, 'utf8').toString('hex')
      : '0x' // empty prefix = match all FiberQuest tournaments

    const result = await this._rpc('get_cells', [
      {
        script: { code_hash: ALWAYS_SUCCESS_CODE_HASH, hash_type: 'data1', args },
        script_type: 'type',
        with_data: true
      },
      'desc',
      '0x64' // up to 100 cells
    ])

    const tournaments = []
    for (const cell of result.objects || []) {
      const data = this.decodeData(cell.output_data || cell.outputData)
      if (!data) continue // skips non-FQTX cells (false positive guard)
      tournaments.push({
        ...data,
        outPoint:    { txHash: cell.out_point?.tx_hash || cell.outPoint?.txHash, index: cell.out_point?.index || cell.outPoint?.index },
        capacityCkb: Number(BigInt(cell.output.capacity)) / 1e8
      })
    }
    return tournaments
  }

  // ── Write operations ──────────────────────────────────────────────────────

  /**
   * Create a new ESCROW tournament cell on-chain.
   * Returns { txHash, outPoint }
   */
  async createEscrowCell (tournament) {
    if (!this.wallet) throw new Error('wallet required for writes')
    const data = this.encodeData({ ...tournament, state: STATE.ESCROW })
    const capacity = this.minCapacityShannons(data, tournament.id)
    const typeScript = this._tournamentTypeScript(tournament.id)

    const outputs = [{
      capacity: `0x${capacity.toString(16)}`,
      lock: {
        codeHash: SECP256K1_CODE_HASH,
        hashType: 'type',
        args: this.wallet.lockArgs
      },
      type: typeScript
    }]

    const signedTx = await this.wallet.buildAndSignTx({
      outputs,
      outputsData: [data],
      extraCellDeps: [{ outPoint: this.alwaysSuccessDep, depType: 'code' }]
    })
    const txHash = await this.wallet.sendRawTx(signedTx)

    console.log(`[ChainStore] Escrow cell created: ${txHash}`)
    return { txHash, outPoint: { txHash, index: '0x0' } }
  }

  /**
   * Update a tournament cell — consume old cell, create new with updated data.
   * Returns new txHash.
   */
  async updateCell (outPoint, updatedTournament) {
    if (!this.wallet) throw new Error('wallet required for writes')
    const data = this.encodeData(updatedTournament)
    const capacity = this.minCapacityShannons(data, updatedTournament.id)
    const typeScript = this._tournamentTypeScript(updatedTournament.id)

    const cellInput = {
      previousOutput: { txHash: outPoint.txHash, index: outPoint.index },
      since: '0x0'
    }

    const outputs = [{
      capacity: `0x${capacity.toString(16)}`,
      lock: {
        codeHash: SECP256K1_CODE_HASH,
        hashType: 'type',
        args: this.wallet.lockArgs
      },
      type: typeScript
    }]

    const signedTx = await this.wallet.buildAndSignTx({
      outputs,
      outputsData: [data],
      extraInputs: [cellInput],
      extraCellDeps: [{ outPoint: this.alwaysSuccessDep, depType: 'code' }]
    })
    const txHash = await this.wallet.sendRawTx(signedTx)

    console.log(`[ChainStore] Cell updated (${updatedTournament.state}): ${txHash}`)
    return { txHash, outPoint: { txHash, index: '0x0' } }
  }

  /**
   * Transition ESCROW → FUNDING (min players met) or → CANCELLED (min not met).
   */
  async closeRegistration (outPoint, tournament) {
    const metMin = tournament.players.filter(p => p.paid).length >= tournament.minPlayers
    const newState = metMin ? STATE.FUNDING : STATE.CANCELLED
    console.log(`[ChainStore] Registration closed: ${metMin ? 'proceeding' : 'cancelled'} (${tournament.players.filter(p=>p.paid).length}/${tournament.minPlayers} paid)`)
    return this.updateCell(outPoint, { ...tournament, state: newState })
  }

  /**
   * Transition FUNDING → ACTIVE (game starting).
   */
  async activateTournament (outPoint, tournament) {
    return this.updateCell(outPoint, { ...tournament, state: STATE.ACTIVE })
  }

  /**
   * Transition ACTIVE → SETTLING (game ended, start buffer period).
   */
  async beginSettlement (outPoint, tournament, winner) {
    return this.updateCell(outPoint, {
      ...tournament,
      state: STATE.SETTLING,
      winner,
      settledAt: Date.now()
    })
  }

  /**
   * Transition SETTLING → COMPLETE (buffer elapsed, payout done).
   */
  async completeTournament (outPoint, tournament) {
    return this.updateCell(outPoint, { ...tournament, state: STATE.COMPLETE })
  }

  /**
   * Submit a player's score as a standalone cell on-chain.
   * Each agent writes their OWN score cell — no cell contention.
   * Data format: JSON with tournamentId, playerId, score, koCount, eventLogHash
   * All agents scan for these cells to discover scores.
   */
  /**
   * Submit a player's score as a standalone cell on-chain.
   * Sent to the ORGANISER's address so all agents can find it by scanning
   * the organiser's cells (same discovery pattern as deposits).
   * Data: JSON with type:'fq_score', tournamentId, playerId, score
   */
  async submitScoreCell (wallet, tournamentId, playerId, scoreData, organizerAddress) {
    if (!wallet) throw new Error('Wallet required to submit score cell')
    const payload = JSON.stringify({
      type: 'fq_score',
      tournamentId,
      playerId,
      score:        scoreData.score,
      koCount:      scoreData.koCount || 0,
      eventLogHash: scoreData.eventLogHash || null,
      submittedAt:  Date.now()
    })
    const data = '0x' + Buffer.from(payload).toString('hex')
    const dataBytes = BigInt(payload.length)
    const minCapacity = (61n + dataBytes) * 100_000_000n
    const capacity = minCapacity > 6200000000n ? minCapacity : 6200000000n

    // Send to organiser's address (or own address if we ARE the organiser)
    const destLock = organizerAddress
      ? require('@nervosnetwork/ckb-sdk-utils').addressToScript(organizerAddress)
      : wallet.lockScript

    const outputs = [{
      capacity: `0x${capacity.toString(16)}`,
      lock: destLock
    }]
    const signedTx = await wallet.buildAndSignTx({
      outputs,
      outputsData: [data]
    })
    const txHash = await wallet.sendRawTx(signedTx)
    console.log(`[ChainStore] Score cell submitted: ${txHash} (${playerId}: ${scoreData.score})`)
    return { txHash }
  }

  /**
   * Scan organiser's cells for score submissions matching a tournament ID.
   * All agents write score cells to the organiser's address, so scanning
   * organiser cells finds ALL scores.
   */
  async scanScoreCells (wallet, tournamentId, organizerAddress) {
    if (!wallet) return []
    // Scan organiser's cells (where all score cells are sent)
    let cells
    if (organizerAddress && organizerAddress !== wallet.address) {
      const utils = require('@nervosnetwork/ckb-sdk-utils')
      const lock = utils.addressToScript(organizerAddress)
      cells = await wallet.getCellsForLock(lock, 200)
    } else {
      cells = await wallet.getLiveCells(200)
    }
    const scores = []
    for (const cell of cells) {
      if (!cell.outputData || cell.outputData === '0x') continue
      try {
        const json = Buffer.from(cell.outputData.slice(2), 'hex').toString()
        const parsed = JSON.parse(json)
        if (parsed.type === 'fq_score' && parsed.tournamentId === tournamentId) {
          scores.push(parsed)
        }
      } catch (_) {}
    }
    return scores
  }

  /**
   * Consume a COMPLETE or CANCELLED cell (no new cell created — reclaims CKB).
   */
  async consumeCell (outPoint) {
    if (!this.wallet) throw new Error('wallet required for writes')
    const cellInput = {
      previousOutput: { txHash: outPoint.txHash, index: outPoint.index },
      since: '0x0'
    }
    // Get the cell's capacity to return to agent wallet
    const signedTx = await this.wallet.buildAndSignTx({
      outputs: [],
      outputsData: [],
      extraInputs: [cellInput]
    })
    return this.wallet.sendRawTx(signedTx)
  }
}

module.exports = { ChainStore, STATE }
