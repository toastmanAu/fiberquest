'use strict'

/**
 * chain-store.js — On-chain tournament storage for FiberQuest v0.3.0
 *
 * Tournament lifecycle (v0.3.0 — block-deterministic, Fiber-native):
 *
 *  1. OPEN      — TC created, registration open until entryCutoffBlock.
 *                 PAs create intent cells to signal interest.
 *                 TM scans for intents, batches into TC rewrites.
 *
 *  2a. CANCELLED — playerCount not met by entryCutoffBlock.
 *                  Fiber channels close cooperatively, CKB returned.
 *
 *  2b. FUNDED    — All registered players have open Fiber channels.
 *                  Waiting for startBlock.
 *
 *  3. ACTIVE     — startBlock reached. All agents start simultaneously.
 *
 *  4. SETTLING   — endBlock reached. Score cells submitted.
 *
 *  5. COMPLETE   — Winner determined, Fiber payout via hub routing.
 *
 * Cell types:
 *   Tournament Cell (TC): FQTX magic | Lock: TM secp256k1 | Type: always-success(tournamentId)
 *   Intent Cell:          FQIN magic | Lock: PA secp256k1 | Type: always-success(tournamentId)
 *   Score Cell:           fq_score JSON | Lock: PA or organiser
 *
 * Scanning: get_cells by type script code hash — global discovery, no registry.
 */

const MAGIC = Buffer.from('FQTX')        // Tournament cell magic
const INTENT_MAGIC = Buffer.from('FQIN')  // Intent cell magic
const VERSION = 2  // v0.3.0 — block-based, intent cells

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

// States (v0.3.0 lifecycle)
const STATE = {
  OPEN:      'OPEN',      // registration open, accepting intent cells
  CANCELLED: 'CANCELLED', // playerCount not met by cutoff — channels close, refund
  FUNDED:    'FUNDED',    // all players have Fiber channels open, waiting for startBlock
  ACTIVE:    'ACTIVE',    // game in progress (startBlock reached)
  SETTLING:  'SETTLING',  // game ended (endBlock reached), score cells being submitted
  COMPLETE:  'COMPLETE',  // winner determined, payout done
  // Legacy aliases for v0.2.0 compatibility
  ESCROW:    'OPEN',
  FUNDING:   'FUNDED',
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
      v:                    VERSION,
      id:                   tournament.id,
      state:                tournament.state,
      gameId:               tournament.gameId,
      modeId:               tournament.modeId,
      entryFee:             tournament.entryFee,                // CKB
      currency:             tournament.currency || 'Fibt',
      playerCount:          tournament.playerCount || 2,        // fixed player count (1-10)
      registeredPlayers:    tournament.registeredPlayers || 0,  // how many registered so far
      tournamentMode:       tournament.tournamentMode || 'local',
      // Organiser info
      fiberPeerId:          tournament.fiberPeerId || '',
      fiberAddress:         tournament.fiberAddress || '',
      organizerAddress:     tournament.organizerAddress || null,
      // Players: [{id, name, address, fiberPeerId, channelFunded, agentCodeHash}]
      players:              tournament.players || [],
      prizePool:            tournament.prizePool || 0,
      winner:               tournament.winner || null,
      createdAt:            tournament.createdAt || Date.now(),
      // Block-based lifecycle (v0.3.0 — deterministic timing)
      entryCutoffBlock:     tournament.entryCutoffBlock || null,   // registration closes
      startBlock:           tournament.startBlock || null,         // game begins
      endBlock:             tournament.endBlock || null,           // game ends
      durationBlocks:       tournament.durationBlocks || null,     // blocks of play
      submissionWindowBlocks: tournament.submissionWindowBlocks || 10, // blocks for score submission after end
      // ROM + agent verification
      romHash:              tournament.romHash || null,
      approvedAgentHashes:  tournament.approvedAgentHashes || [],
      // Settlement
      scoreSubmissions:     tournament.scoreSubmissions || null,
      winnerInvoice:        tournament.winnerInvoice || null,
    }
    const json = Buffer.from(JSON.stringify(payload))
    return '0x' + Buffer.concat([MAGIC, Buffer.from([VERSION]), json]).toString('hex')
  }

  /**
   * Encode intent cell data (PA signals tournament join interest).
   */
  encodeIntentData (intent) {
    const payload = {
      tournamentId:   intent.tournamentId,
      playerAddress:  intent.playerAddress,
      fiberPeerId:    intent.fiberPeerId || '',
      agentCodeHash:  intent.agentCodeHash || '',
      createdAtBlock: intent.createdAtBlock || null,
    }
    const json = Buffer.from(JSON.stringify(payload))
    return '0x' + Buffer.concat([INTENT_MAGIC, Buffer.from([VERSION]), json]).toString('hex')
  }

  decodeIntentData (hexData) {
    if (!hexData || hexData === '0x') return null
    const buf = Buffer.from(hexData.slice(2), 'hex')
    if (buf.length < 6) return null
    if (!buf.slice(0, 4).equals(INTENT_MAGIC)) return null
    try {
      return JSON.parse(buf.slice(5).toString())
    } catch {
      return null
    }
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

    const searchKey = {
      script: { code_hash: ALWAYS_SUCCESS_CODE_HASH, hash_type: 'data1', args },
      script_type: 'type',
      with_data: true
    }

    // Paginate through all cells (indexer caps per-request)
    const allCells = []
    let cursor = null
    for (let page = 0; page < 10; page++) { // safety cap: 10 pages × 200 = 2000 cells
      const params = cursor
        ? [searchKey, 'desc', '0xC8', cursor] // 200 per page, with cursor
        : [searchKey, 'desc', '0xC8']
      const result = await this._rpc('get_cells', params)
      const objects = result.objects || []
      allCells.push(...objects)
      if (objects.length < 200 || !result.last_cursor) break
      cursor = result.last_cursor
    }

    const tournaments = []
    for (const cell of allCells) {
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
   * Create a new tournament cell on-chain (state: OPEN).
   * TM-locked — only the organiser can rewrite/consume it.
   * Returns { txHash, outPoint }
   */
  async createTournamentCell (tournament) {
    if (!this.wallet) throw new Error('wallet required for writes')
    const data = this.encodeData({ ...tournament, state: STATE.OPEN })
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

    console.log(`[ChainStore] Tournament cell created (OPEN): ${txHash}`)
    return { txHash, outPoint: { txHash, index: '0x0' } }
  }

  /** @deprecated Use createTournamentCell */
  async createEscrowCell (tournament) {
    return this.createTournamentCell(tournament)
  }

  /**
   * Create an intent cell (PA signals interest in joining a tournament).
   * PA-locked — only the participant can consume it (to reclaim CKB).
   * Uses same type script as tournament cells (args = tournament ID) for discovery.
   */
  async createIntentCell (wallet, tournamentId, intentData) {
    const data = this.encodeIntentData({ ...intentData, tournamentId })
    const dataBytes = BigInt((data.length - 2) / 2)
    const typeArgBytes = BigInt(Buffer.from(tournamentId, 'utf8').length)
    const capacity = (8n + 53n + 33n + typeArgBytes + dataBytes) * CKB_PER_BYTE
    const typeScript = this._tournamentTypeScript(tournamentId)

    const outputs = [{
      capacity: `0x${capacity.toString(16)}`,
      lock: {
        codeHash: SECP256K1_CODE_HASH,
        hashType: 'type',
        args: wallet.lockArgs
      },
      type: typeScript
    }]

    const signedTx = await wallet.buildAndSignTx({
      outputs,
      outputsData: [data],
      extraCellDeps: [{ outPoint: this.alwaysSuccessDep, depType: 'code' }]
    })
    const txHash = await wallet.sendRawTx(signedTx)

    console.log(`[ChainStore] Intent cell created for ${tournamentId}: ${txHash}`)
    return { txHash, outPoint: { txHash, index: '0x0' } }
  }

  /**
   * Scan for intent cells matching a tournament ID.
   * Returns array of { intentData, outPoint, lockArgs, capacityCkb }
   * Filters by FQIN magic prefix to distinguish from tournament cells.
   */
  async scanIntentCells (tournamentId) {
    const args = '0x' + Buffer.from(tournamentId, 'utf8').toString('hex')

    const result = await this._rpc('get_cells', [
      {
        script: { code_hash: ALWAYS_SUCCESS_CODE_HASH, hash_type: 'data1', args },
        script_type: 'type',
        with_data: true
      },
      'desc',
      '0x64'
    ])

    const intents = []
    for (const cell of result.objects || []) {
      const intentData = this.decodeIntentData(cell.output_data || cell.outputData)
      if (!intentData) continue // skip tournament cells (FQTX) and non-intent cells
      intents.push({
        ...intentData,
        outPoint:    { txHash: cell.out_point?.tx_hash, index: cell.out_point?.index },
        lockArgs:    cell.output?.lock?.args,
        capacityCkb: Number(BigInt(cell.output.capacity)) / 1e8,
      })
    }
    return intents
  }

  /**
   * Batch-register players: consume TC + output new TC with updated players array.
   * One transaction per batch — efficient when multiple intents found in same scan.
   */
  async batchRegisterPlayers (tcOutPoint, tournament, newPlayers) {
    const updatedPlayers = [...(tournament.players || [])]
    for (const p of newPlayers) {
      if (!updatedPlayers.find(ep => ep.address === p.playerAddress)) {
        updatedPlayers.push({
          id:             `player-${updatedPlayers.length}`,
          name:           p.playerAddress?.slice(-8) || `player-${updatedPlayers.length}`,
          address:        p.playerAddress,
          fiberPeerId:    p.fiberPeerId,
          agentCodeHash:  p.agentCodeHash,
          paid:           true,  // Intent cell creation = proof of L1 deposit
          channelFunded:  false,
          registeredAt:   Date.now(),
        })
      }
    }

    const updated = {
      ...tournament,
      players: updatedPlayers,
      registeredPlayers: updatedPlayers.length,
    }

    console.log(`[ChainStore] Batch registering ${newPlayers.length} players (total: ${updatedPlayers.length}/${tournament.playerCount})`)
    return this.updateCell(tcOutPoint, updated)
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
   * Transition OPEN → FUNDED (all players registered + channels open) or → CANCELLED.
   */
  async closeRegistration (outPoint, tournament) {
    const allFunded = (tournament.registeredPlayers || 0) >= tournament.playerCount &&
      (tournament.players || []).every(p => p.channelFunded)
    const newState = allFunded ? STATE.FUNDED : STATE.CANCELLED
    console.log(`[ChainStore] Registration closed: ${allFunded ? 'funded' : 'cancelled'} (${tournament.registeredPlayers}/${tournament.playerCount})`)
    return this.updateCell(outPoint, { ...tournament, state: newState })
  }

  /**
   * Transition FUNDED → ACTIVE (startBlock reached, game starting).
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
