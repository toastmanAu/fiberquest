'use strict'

/**
 * agent-wallet.js — CKB wallet for FiberQuest tournament agent
 *
 * Manages the on-chain key and signs tournament cell transactions.
 * Private key is loaded from CKB_PRIVATE_KEY env var (64-char hex, no 0x prefix).
 */

const http   = require('http')
const os     = require('os')
const crypto = require('crypto')
const CKB = require('@nervosnetwork/ckb-sdk-core').default
const utils = require('@nervosnetwork/ckb-sdk-utils')

/** Return first non-loopback IPv4 address on the LAN */
function getLocalIP () {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return '127.0.0.1'
}

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

// JoyID lock constants (from @joyid/ckb)
const JOYID_CODE_HASH_TESTNET = '0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac'
const JOYID_CODE_HASH_MAINNET = '0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323'
const JOYID_DEP_TESTNET = {
  outPoint: { txHash: '0x4dcf3f3b09efac8995d6cbee87c5345e812d310094651e0c3d9a730f32dc9263', index: '0x0' },
  depType: 'depGroup',
}
const JOYID_DEP_MAINNET = {
  outPoint: { txHash: '0x06d4b4cc802115633b0ed89fac859504b1c08c93869ee9748b1d17c1d0e149ae', index: '0x0' },
  depType: 'depGroup',
}

// Deposit output marker prefix — stored in outputsData[0] so each player slot is unambiguous
// Format: hex(tournamentId + '-' + slotIndex)  e.g. "fq_abc_1234-0"
function depositDataMarker (tournamentId, slotIndex) {
  return '0x' + Buffer.from(`${tournamentId}-${slotIndex}`).toString('hex')
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

    // JoyID callback server — started lazily on first buildJoyIDSignTxUrl call
    this._callbackPort    = opts.callbackPort || 8766
    this._callbackServer  = null
    this._callbackHandlers = new Map()  // callbackId → (signedTx) => void
  }

  // ── JoyID callback server ─────────────────────────────────────────────────

  /**
   * Decode a JoyID redirect response from the _data_ query param.
   * JoyID uses qss encoding: key=urlencoded(jsonStringifiedValue)&...
   * Wrapped as DappResponse: { data: <AuthResponseData|SignCkbTxResponseData>, error: null }
   */
  _decodeJoyIDData (raw) {
    if (!raw) return null
    const str = raw.startsWith('?') ? raw.slice(1) : raw
    const out = {}
    for (const pair of str.split('&')) {
      if (!pair) continue
      const eqIdx = pair.indexOf('=')
      const k = decodeURIComponent(pair.slice(0, eqIdx))
      const v = decodeURIComponent(pair.slice(eqIdx + 1))
      try { out[k] = JSON.parse(v) } catch { out[k] = v }
    }
    return out
  }

  /**
   * Start the local HTTP server that catches JoyID redirect callbacks.
   * JoyID redirects the phone browser back to:
   *   http://<localIP>:<port>/joyid/<callbackId>?joyid-redirect=true&_data_=<qss-encoded DappResponse>
   */
  startCallbackServer () {
    if (this._callbackServer) return  // already running
    this._callbackServer = http.createServer((req, res) => {
      // Log every incoming request so we can debug callback delivery
      console.log(`[AgentWallet] Callback server ← ${req.method} ${req.url}`)
      try {
        const url  = new URL(req.url, `http://localhost:${this._callbackPort}`)
        // cbId is in the path; joyid-redirect=true and _data_ are added by JoyID
        const cbId  = url.pathname.replace(/^\/joyid\//, '').replace(/\/$/, '')
        const raw   = url.searchParams.get('_data_')

        console.log(`[AgentWallet] cbId=${cbId} hasHandler=${this._callbackHandlers.has(cbId)} hasData=${!!raw}`)

        if (!cbId || !this._callbackHandlers.has(cbId)) {
          res.writeHead(404); res.end('Not found'); return
        }

        if (!raw) {
          console.error('[AgentWallet] JoyID callback missing _data_ param — url:', req.url)
          res.writeHead(400); res.end('Missing _data_'); return
        }

        // Decode qss DappResponse wrapper: { data: <payload>, error: null }
        const wrapper = this._decodeJoyIDData(raw)
        if (wrapper?.error) {
          console.error('[AgentWallet] JoyID returned error:', wrapper.error)
          res.writeHead(400); res.end('JoyID error'); return
        }

        const payload = wrapper?.data ?? wrapper
        console.log('[AgentWallet] JoyID callback payload:', JSON.stringify(payload)?.slice(0, 200))

        const handler = this._callbackHandlers.get(cbId)
        this._callbackHandlers.delete(cbId)

        // Respond to phone immediately — submission happens async
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body style="font-family:sans-serif;text-align:center;padding:2rem">' +
                '<h1>✅ Done!</h1><p>You can close this tab.</p></body></html>')

        Promise.resolve(handler(payload)).catch(e =>
          console.error('[AgentWallet] JoyID callback handler error:', e.message)
        )
      } catch (e) {
        console.error('[AgentWallet] JoyID callback parse error:', e.message, 'url:', req.url)
        res.writeHead(400); res.end('Bad request')
      }
    })

    this._callbackServer.listen(this._callbackPort, () => {
      console.log(`[AgentWallet] JoyID callback server listening on :${this._callbackPort}`)
    })
  }

  /**
   * Register a one-shot callback for a JoyID sign result.
   * Returns the callback URL to embed in the JoyID deep-link.
   */
  registerJoyIDCallback (handler) {
    this.startCallbackServer()
    const cbId = crypto.randomUUID().replace(/-/g, '')
    this._callbackHandlers.set(cbId, handler)
    const localIP = getLocalIP()
    // joyid-redirect=true is required — JoyID only redirects back if this param is present
    return `http://${localIP}:${this._callbackPort}/joyid/${cbId}?joyid-redirect=true`
  }

  /**
   * Build a JoyID connect URL — player scans QR, approves in JoyID app,
   * agent receives their CKB address + pubkey via callback.
   *
   * No address entry needed. This is the frictionless onboarding step.
   * Call BEFORE buildJoyIDSignTxUrl — connect gives you the address.
   *
   * @param {function} onConnect  - callback({ address, pubkey, keyType })
   * @returns {string}  JoyID connect URL (encode as QR to show player)
   */
  buildJoyIDConnectUrl (onConnect) {
    // testnet.joyid.dev for testnet, app.joy.id for mainnet
    const joyidBase   = this.isMainnet ? 'https://app.joy.id' : 'https://testnet.joyid.dev'
    const callbackUrl = this.registerJoyIDCallback((payload) => {
      // payload is AuthResponseData: { address, pubkey, keyType, alg, ... }
      if (!payload?.address) {
        console.error('[AgentWallet] JoyID connect callback missing address:', payload)
        return
      }
      onConnect({
        address: payload.address,
        pubkey:  payload.pubkey  || null,
        keyType: payload.keyType || 'main_key',
      })
    })

    const request = {
      redirectURL:    callbackUrl,
      name:           'FiberQuest',
      logo:           'https://raw.githubusercontent.com/toastmanAu/fiberquest/main/renderer/logo.jpeg',
      requestNetwork: 'nervos',
    }

    const parts = []
    for (const [k, v] of Object.entries(request)) {
      if (v === undefined || v === null) continue
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`)
    }
    const dataStr = '?' + parts.join('&')
    const url     = new URL(`${joyidBase}/auth`)
    url.searchParams.set('type', 'redirect')
    url.searchParams.set('_data_', dataStr)
    console.log('[AgentWallet] JoyID connect URL (first 200):', url.href.slice(0, 200))
    console.log('[AgentWallet] Callback URL:', callbackUrl)
    return url.href
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
   * Fetch live cells for any lock script (not just the agent's own lock).
   * Used to gather player input cells when building a deposit transaction.
   */
  async getCellsForLock (lockScript, maxCount = 50) {
    const result = await this._rpc('get_cells', [
      {
        script: {
          code_hash: lockScript.codeHash,
          hash_type: lockScript.hashType,
          args: lockScript.args,
        },
        script_type: 'lock',
        filter: { output_capacity_range: ['0x0', '0xffffffffffffffff'] },
        with_data: false,
      },
      'desc',
      `0x${maxCount.toString(16)}`,
    ])
    return (result.objects || []).map(c => ({
      outPoint:   { txHash: c.out_point.tx_hash, index: c.out_point.index },
      output:     { capacity: c.output.capacity, lock: c.output.lock, type: c.output.type },
      outputData: c.output_data ?? '0x',
    }))
  }

  /**
   * Build a raw CKB transaction for a player's tournament entry fee.
   *
   * inputs:  player's plain-CKB cells (fetched from chain)
   * outputs:
   *   [0] → agent address, capacity = entryFee, outputData = depositDataMarker(tId, slot)
   *   [1] → player address, capacity = change (omitted if zero after fees)
   *
   * The outputsData marker makes each player slot unambiguous — no collision possible
   * even if many players pay the same fee in the same block.
   *
   * @returns {{ rawTx: object, dataMarker: string }}
   */
  async buildPlayerDepositTx (playerAddress, tournamentId, slotIndex, entryFeeCkb) {
    const playerLock   = utils.addressToScript(playerAddress)
    const entryShannon = BigInt(Math.round(entryFeeCkb * 1e8))
    const feeShannons  = 5000n
    const needed       = entryShannon + feeShannons

    // Detect player lock type to pick the right cell dep
    const isJoyID = playerLock.codeHash === JOYID_CODE_HASH_TESTNET ||
                    playerLock.codeHash === JOYID_CODE_HASH_MAINNET
    const playerCellDep = isJoyID
      ? (this.isMainnet ? JOYID_DEP_MAINNET : JOYID_DEP_TESTNET)
      : { outPoint: this.secp256k1Dep, depType: 'depGroup' }

    // Gather player inputs
    const playerCells = await this.getCellsForLock(playerLock, 50)
    const plainCells  = playerCells.filter(c => !c.outputData || c.outputData === '0x')
    const inputs = []
    let   collected = 0n
    for (const cell of plainCells) {
      if (collected >= needed) break
      // Skip tiny cells that can't cover their own min capacity after being consumed
      inputs.push({
        previousOutput: { txHash: cell.outPoint.txHash, index: cell.outPoint.index },
        since: '0x0',
      })
      collected += BigInt(cell.output.capacity)
    }
    if (collected < needed) {
      throw new Error(`Player has insufficient CKB: need ${Number(needed) / 1e8} CKB, have ${Number(collected) / 1e8} CKB`)
    }

    // Deposit output — tagged with the tournament+slot marker
    const marker       = depositDataMarker(tournamentId, slotIndex)
    const markerBytes  = BigInt((marker.length - 2) / 2)   // bytes of actual data (no 0x prefix)
    // CKB min capacity: 8 (cap field) + lock script bytes + data bytes
    // Agent secp256k1 lock: 32+1+20 = 53 bytes → cell min = 61 + markerBytes
    const depositMinShannon = (61n + markerBytes) * 100_000_000n
    const depositCapacity   = entryShannon > depositMinShannon ? entryShannon : depositMinShannon

    // Change back to player
    const changeShannon = collected - depositCapacity - feeShannons
    // Player secp256k1/JoyID lock: also ~53 bytes → min 61 CKB change
    const changeMinShannon = 61n * 100_000_000n

    const outputs     = [{ capacity: `0x${depositCapacity.toString(16)}`, lock: this.lockScript, type: null }]
    const outputsData = [marker]
    if (changeShannon >= changeMinShannon) {
      outputs.push({ capacity: `0x${changeShannon.toString(16)}`, lock: playerLock, type: null })
      outputsData.push('0x')
    }
    // else: change absorbed into fee (only happens if player barely has enough)

    const witnesses = inputs.map((_, i) => i === 0 ? '0x' : '0x')

    const rawTx = {
      version:     '0x0',
      cellDeps:    [playerCellDep],
      headerDeps:  [],
      inputs,
      outputs,
      outputsData,
      witnesses,
    }

    return { rawTx, dataMarker: marker }
  }

  /**
   * Encode a raw CKB transaction as a JoyID deep-link URL for mobile signing.
   * Replicates @joyid/common buildJoyIDURL without importing the browser SDK.
   *
   * JoyID signs the tx and redirects the phone's browser to callbackUrl with
   * the signed tx in ?_result_=<base64>. The local callback server submits it.
   *
   * @param {object} rawTx         - CKBTransaction (camelCase SDK format)
   * @param {string} playerAddress - signer's CKB address
   * @param {string} callbackUrl   - local HTTP URL for JoyID redirect (from registerJoyIDCallback)
   * @returns {string}  Full JoyID deep-link URL
   */
  buildJoyIDSignTxUrl (rawTx, playerAddress, callbackUrl) {
    const joyidBase = this.isMainnet ? 'https://app.joy.id' : 'https://testnet.joyid.dev'
    const request = {
      tx:             rawTx,
      signerAddress:  playerAddress,
      redirectURL:    callbackUrl,
      name:           'FiberQuest',
      witnessIndexes: [0],
    }
    const parts = []
    for (const [k, v] of Object.entries(request)) {
      if (v === undefined || v === null) continue
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v)
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`)
    }
    const dataStr = '?' + parts.join('&')
    const url     = new URL(`${joyidBase}/sign-ckb-raw-tx`)
    url.searchParams.set('type', 'redirect')
    url.searchParams.set('_data_', dataStr)
    return url.href
  }

  /**
   * Poll the chain for a deposit cell matching the given tournament+slot marker.
   * Returns the cell once found. Much more reliable than amount-based matching.
   */
  async pollForDepositByMarker (tournamentId, slotIndex, { intervalMs = 6000, timeoutMs = 900000 } = {}) {
    const marker   = depositDataMarker(tournamentId, slotIndex)
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const cells = await this.getLiveCells(200)
          const match = cells.find(c =>
            (c.outputData || '0x').toLowerCase() === marker.toLowerCase()
          )
          if (match) return resolve(match)
          console.log(`[AgentWallet] Waiting for deposit marker ${tournamentId}-${slotIndex}…`)
        } catch (e) {
          console.warn('[AgentWallet] Deposit marker poll error:', e.message)
        }
        if (Date.now() > deadline) return reject(new Error('Deposit timeout'))
        setTimeout(tick, intervalMs)
      }
      tick()
    })
  }

  /**
   * @deprecated — replaced by data-marker detection (buildPlayerDepositTx flow)
   * Kept for Fiber invoice fallback path.
   */
  buildJoyIDUri (tournamentId, slotIndex, amountCkb) {
    const data = `${tournamentId}-${slotIndex}`
    const dataHex = '0x' + Buffer.from(data).toString('hex')
    return `nervos:${this.address}?amount=${amountCkb}&data=${dataHex}`
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
   * Find deposit cells matching a specific data marker (exact match).
   * Used to confirm a player's tx was broadcast and landed on-chain.
   * @param {string} dataMarker  - hex string from depositDataMarker()
   */
  async findDepositByMarker (dataMarker) {
    const cells = await this.getLiveCells(200)
    return cells.find(c =>
      (c.outputData || '0x').toLowerCase() === dataMarker.toLowerCase()
    ) || null
  }

  /**
   * @deprecated — fallback for Fiber invoice path
   */
  async findNewDeposits (snapshot, minCapacityShannon) {
    const cells = await this.getLiveCells(200)
    return cells
      .filter(c => {
        const key = `${c.outPoint.txHash}:${c.outPoint.index}`
        if (snapshot.has(key)) return false
        if (BigInt(c.output.capacity) < BigInt(minCapacityShannon)) return false
        return !c.outputData || c.outputData === '0x'
      })
      .reverse()
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
      // Get the deposit transaction
      const txHash = cell.out_point?.tx_hash || cell.outPoint?.txHash
      const tx = await this._rpc('get_transaction', [txHash])
      // The first input cell was owned by the sender — its lock IS the sender's address
      const firstInput = tx?.transaction?.inputs?.[0]
      if (!firstInput) return null
      const prevOut    = firstInput.previous_output || firstInput.previousOutput
      const prevTxHash = prevOut.tx_hash || prevOut.txHash
      const prevIndex  = parseInt(prevOut.index, 16)
      // Input cell is spent so get_live_cell won't work — fetch via its creating tx
      const prevTx = await this._rpc('get_transaction', [prevTxHash])
      const lock   = prevTx?.transaction?.outputs?.[prevIndex]?.lock
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

module.exports = { AgentWallet, depositDataMarker }
