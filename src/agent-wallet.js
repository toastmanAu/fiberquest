'use strict'

/**
 * agent-wallet.js — CKB wallet for FiberQuest tournament agent
 *
 * Manages the on-chain key and signs tournament cell transactions.
 * Private key is loaded from CKB_PRIVATE_KEY env var (64-char hex, no 0x prefix).
 */

const CKB = require('@nervosnetwork/ckb-sdk-core').default
const utils = require('@nervosnetwork/ckb-sdk-utils')

const SECP256K1_CODE_HASH = '0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8'
// secp256k1 dep group outpoint — genesis block tx[1] index 0
// Testnet: 0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37
// Mainnet: 0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c
const SECP256K1_DEP_OUTPOINT_TESTNET = {
  txHash: '0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37',
  index: '0x0'
}
const SECP256K1_DEP_OUTPOINT_MAINNET = {
  txHash: '0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c',
  index: '0x0'
}

class AgentWallet {
  constructor (opts = {}) {
    const rawKey = opts.privateKey || process.env.CKB_PRIVATE_KEY
    if (!rawKey) throw new Error('CKB_PRIVATE_KEY not set')
    this.privateKey = rawKey.startsWith('0x') ? rawKey : '0x' + rawKey

    this.rpcUrl = opts.rpcUrl || process.env.CKB_RPC_URL || 'https://testnet.ckbapp.dev/'
    this.ckb = new CKB(this.rpcUrl)

    this.isMainnet = (opts.network || process.env.CKB_NETWORK || 'testnet') === 'mainnet'
    this.secp256k1Dep = this.isMainnet ? SECP256K1_DEP_OUTPOINT_MAINNET : SECP256K1_DEP_OUTPOINT_TESTNET
    // Derive lock args via legacy address, then build full CKB2021 address
    const legacyAddr = utils.privateKeyToAddress(this.privateKey, { prefix: this.isMainnet ? 'ckb' : 'ckt' })
    const script = utils.addressToScript(legacyAddr)
    this.lockArgs  = script.args
    this.lockScript = {
      codeHash: SECP256K1_CODE_HASH,
      hashType: 'type',
      args: this.lockArgs
    }
    // Full bech32m address (CKB2021 format — not deprecated short form)
    this.address = utils.scriptToAddress(this.lockScript, this.isMainnet)
  }

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

  async getLiveCells (maxCount = 20) {
    const result = await this._rpc('get_cells', [
      {
        script: { code_hash: SECP256K1_CODE_HASH, hash_type: 'type', args: this.lockArgs },
        script_type: 'lock',
        filter: { output_capacity_range: ['0x0', '0xffffffffffffffff'] },
        with_data: true,
      },
      'desc',
      `0x${maxCount.toString(16)}`
    ])
    // Normalize snake_case RPC response to camelCase for callers
    return (result.objects || []).map(c => ({
      outPoint:   { txHash: c.out_point.tx_hash, index: c.out_point.index },
      output:     { capacity: c.output.capacity, lock: c.output.lock, type: c.output.type },
      outputData: c.output_data ?? '0x',
    }))
  }

  async buildAndSignTx ({ outputs, outputsData, extraInputs = [], extraCellDeps = [] }) {
    // Gather inputs to cover output capacity + fee
    const totalOutputCap = outputs.reduce((s, o) => s + BigInt(o.capacity), 0n)
    const feeShannons = 5000n
    const needed = totalOutputCap + feeShannons

    const liveCells = await this.getLiveCells(50)
    const inputs = []
    let collected = 0n

    for (const cell of liveCells) {
      // Skip cells that have output data (tournament cells — don't accidentally consume them)
      if (cell.outputData && cell.outputData !== '0x') continue
      inputs.push({
        previousOutput: { txHash: cell.outPoint.txHash, index: cell.outPoint.index },
        since: '0x0'
      })
      collected += BigInt(cell.output.capacity)
      if (collected >= needed) break
    }

    if (collected < needed) throw new Error(`Insufficient CKB: need ${needed}, have ${collected}`)

    // Change output back to self
    const change = collected - totalOutputCap - feeShannons
    const allOutputs = [...outputs]
    const allData = [...outputsData]
    if (change > 0n) {
      allOutputs.push({ capacity: `0x${change.toString(16)}`, lock: this.lockScript, type: null })
      allData.push('0x')
    }

    const allInputs = [...extraInputs, ...inputs]
    // SDK validates transaction.witnesses exists before signing
    const witnesses = allInputs.map((_, i) =>
      i === 0 ? { lock: '', inputType: '', outputType: '' } : '0x'
    )
    const rawTx = {
      version: '0x0',
      cellDeps: [
        { outPoint: this.secp256k1Dep, depType: 'depGroup' },
        ...extraCellDeps
      ],
      headerDeps: [],
      inputs: allInputs,
      outputs: allOutputs,
      outputsData: allData,
      witnesses,
    }

    const signedTx = this.ckb.signTransaction(this.privateKey)(rawTx, witnesses)
    return signedTx
  }

  async sendRawTx (signedTx) {
    return this.ckb.rpc.sendTransaction(signedTx, 'passthrough')
  }

  async getBalance () {
    const cells = await this.getLiveCells(200)
    const total = cells
      .filter(c => !c.outputData || c.outputData === '0x')
      .reduce((s, c) => s + BigInt(c.output.capacity), 0n)
    return Number(total) / 1e8
  }

  /**
   * Build a JoyID payment URI for a tournament player slot.
   * @param {string} tournamentId
   * @param {number} slotIndex    — 0-based slot
   * @param {number} amountCkb   — entry fee in CKB
   * @returns {string}  nervos:<addr>?amount=<shannon>&data=<tId>-<slot>
   */
  buildJoyIDUri (tournamentId, slotIndex, amountCkb) {
    const data = `${tournamentId}-${slotIndex}`
    return `nervos:${this.address}?amount=${amountCkb}&data=${data}`
  }

  /**
   * Snapshot all current plain (empty-data) cell outpoints at the agent address.
   * Call this before opening registration — new cells after this point are deposits.
   */
  async snapshotOutpoints () {
    const cells = await this.getLiveCells(200)
    return new Set(cells.map(c => `${c.outPoint.txHash}:${c.outPoint.index}`))
  }

  /**
   * Find cells that appeared after the snapshot with capacity >= minCapacityShannon.
   * JoyID sends plain CKB (no output_data), so we match by amount + novelty.
   * Returns array of new cells, oldest-first.
   */
  async findNewDeposits (snapshot, minCapacityShannon) {
    const cells = await this.getLiveCells(200)
    return cells
      .filter(c => {
        const key = `${c.outPoint.txHash}:${c.outPoint.index}`
        return !snapshot.has(key) &&
          (!c.outputData || c.outputData === '0x') &&
          BigInt(c.output.capacity) >= BigInt(minCapacityShannon)
      })
      .reverse() // oldest first (getLiveCells is desc)
  }

  /**
   * Poll until at least `count` new deposits appear after the snapshot.
   * Resolves with array of new cells (length >= count).
   */
  async pollForDeposits (snapshot, count, minCapacityCkb, { intervalMs = 6000, timeoutMs = 900000 } = {}) {
    const minShannon = BigInt(Math.round(minCapacityCkb * 1e8))
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const cells = await this.findNewDeposits(snapshot, minShannon)
          console.log(`[AgentWallet] Deposit scan: ${cells.length}/${count} new cells found`)
          if (cells.length >= count) return resolve(cells)
        } catch (e) {
          console.warn('[AgentWallet] Deposit scan error:', e.message)
        }
        if (Date.now() > deadline) return reject(new Error('Deposit timeout — registration window closed'))
        setTimeout(tick, intervalMs)
      }
      tick()
    })
  }

  /**
   * Derive the sender's CKB address from a deposit cell's creating transaction.
   * Looks at the first input of the tx that created this cell.
   */
  async getDepositSender (cell) {
    try {
      const txHash = cell.out_point?.tx_hash || cell.outPoint?.txHash
      const tx = await this._rpc('get_transaction', [txHash])
      const firstInput = tx?.transaction?.inputs?.[0]
      if (!firstInput) return null
      const prevOut = firstInput.previous_output || firstInput.previousOutput
      const inputCell = await this._rpc('get_live_cell', [prevOut, false])
      const lock = inputCell?.cell?.output?.lock
      if (!lock) return null
      return utils.scriptToAddress({
        codeHash: lock.code_hash,
        hashType: lock.hash_type,
        args: lock.args
      }, this.isMainnet)
    } catch {
      return null
    }
  }

  /**
   * Send CKB on L1 to a recipient address.
   * Used for winner payouts when Fiber is unavailable.
   */
  async sendL1Payment (toAddress, amountCkb) {
    const amountShannon = BigInt(Math.round(amountCkb * 1e8))
    const toLock = utils.addressToScript(toAddress)
    const signedTx = await this.buildAndSignTx({
      outputs: [{ capacity: `0x${amountShannon.toString(16)}`, lock: toLock, type: null }],
      outputsData: ['0x'],
    })
    const txHash = await this.sendRawTx(signedTx)
    console.log(`[AgentWallet] L1 payment sent: ${amountCkb} CKB → ${toAddress} — tx: ${txHash}`)
    return txHash
  }
}

module.exports = { AgentWallet }
