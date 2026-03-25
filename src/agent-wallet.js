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
const { buildJoyIDURL, buildJoyIDSignMessageURL, encodeSearch, decodeSearch, base64urlToHex } = require('@joyid/common')
const { calculateChallenge, buildSignedTx } = require('@joyid/ckb')

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
// JoyID requires 5 cell deps (CCC SDK style — the old dep_group cell was consumed)
const JOYID_DEPS_TESTNET = [
  { outPoint: { txHash: '0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9', index: '0x0' }, depType: 'code' },
  { outPoint: { txHash: '0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0xf2c9dbfe7438a8c622558da8fa912d36755271ea469d3a25cb8d3373d35c8638', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x95ecf9b41701b45d431657a67bbfa3f07ef7ceb53bf87097f3674e1a4a19ce62', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x8b3255491f3c4dcc1cfca33d5c6bcaec5409efe4bbda243900f9580c47e0242e', index: '0x1' }, depType: 'code' },
]
const JOYID_DEPS_MAINNET = [
  { outPoint: { txHash: '0xf05188e5f3a6767fc4687faf45ba5f1a6e25d3ada6129dae8722cb282f262493', index: '0x0' }, depType: 'depGroup' },
]

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
    this._redirectStore    = new Map()  // shortId → longUrl (for QR-friendly short URLs)
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
    try { return decodeSearch(str) } catch { /* fall through to manual parse */ }
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
  /**
   * Store a long URL and return a short local redirect URL safe to encode as QR.
   * e.g. http://192.168.x.x:8766/r/<shortId>
   */
  shortenUrl (longUrl, meta = {}) {
    this.startCallbackServer()
    const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    this._redirectStore.set(shortId, { longUrl, meta })
    const localIP = getLocalIP()
    return `http://${localIP}:${this._callbackPort}/r/${shortId}`
  }

  startCallbackServer () {
    if (this._callbackServer) return  // already running
    this._callbackServer = http.createServer((req, res) => {
      // Log every incoming request so we can debug callback delivery
      console.log(`[AgentWallet] Callback server ← ${req.method} ${req.url}`)
      try {
        const url  = new URL(req.url, `http://localhost:${this._callbackPort}`)

        // Short URL redirect — /r/<shortId>
        const rMatch = url.pathname.match(/^\/r\/([a-f0-9]+)$/)
        if (rMatch) {
          const entry = this._redirectStore.get(rMatch[1])
          if (!entry) { res.writeHead(404); res.end('Not found'); return }
          const { longUrl, meta } = entry
          // All short URLs: plain redirect — /sign-ckb uses commuType:redirect so
          // JoyID will redirect back to our callbackUrl directly, no bridge page needed.
          res.writeHead(302, { Location: longUrl })
          res.end()
          return
        }

        // SSE keepalive — keeps bridge tab active so iOS won't suspend it
        if (url.pathname === '/keepalive') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          })
          res.write('data: connected\n\n')
          const ping = setInterval(() => {
            if (res.destroyed) { clearInterval(ping); return }
            res.write('data: ping\n\n')
          }, 10000)
          req.on('close', () => clearInterval(ping))
          return
        }

        // Popup callback — bridge page POSTs the postMessage payload here
        const popupMatch = url.pathname.match(/^\/joyid-popup\/([a-f0-9]+)$/)
        if (popupMatch && req.method === 'POST') {
          const cbId = popupMatch[1]
          if (!this._callbackHandlers.has(cbId)) { res.writeHead(404); res.end('Not found'); return }
          let body = ''
          req.on('data', chunk => { body += chunk })
          req.on('end', () => {
            try {
              let payload
              try { payload = JSON.parse(body) } catch { payload = this._decodeJoyIDData(body) }
              const data = payload?.data ?? payload
              console.log('[AgentWallet] JoyID popup result:', JSON.stringify(data)?.slice(0, 200))
              const handler = this._callbackHandlers.get(cbId)
              this._callbackHandlers.delete(cbId)
              res.writeHead(200); res.end('OK')
              Promise.resolve(handler(data)).catch(e =>
                console.error('[AgentWallet] JoyID popup callback error:', e.message)
              )
            } catch (e) {
              console.error('[AgentWallet] JoyID popup parse error:', e.message)
              res.writeHead(400); res.end('Bad request')
            }
          })
          return
        }

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
    // Shorten so the connect QR is easy to scan on any phone
    return this.shortenUrl(url.href)
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
      // Skip cells that have output data or type scripts (tournament escrow cells)
      if (cell.outputData && cell.outputData !== '0x') continue
      if (cell.output.type) continue
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
  async buildPlayerDepositTx (playerAddress, tournamentId, slotIndex, entryFeeCkb, opts = {}) {
    // For distributed joins, deposit goes to the organizer's address, not this agent
    const destinationLock = opts.destinationAddress
      ? utils.addressToScript(opts.destinationAddress)
      : this.lockScript;
    const playerLock   = utils.addressToScript(playerAddress)
    const entryShannon = BigInt(Math.round(entryFeeCkb * 1e8))
    const feeShannons  = 5000n
    const needed       = entryShannon + feeShannons

    // Detect player lock type to pick the right cell dep
    const isJoyID = playerLock.codeHash === JOYID_CODE_HASH_TESTNET ||
                    playerLock.codeHash === JOYID_CODE_HASH_MAINNET
    const playerCellDeps = isJoyID
      ? (this.isMainnet ? JOYID_DEPS_MAINNET : JOYID_DEPS_TESTNET)
      : [{ outPoint: this.secp256k1Dep, depType: 'depGroup' }]

    // Gather player inputs
    const playerCells = await this.getCellsForLock(playerLock, 50)
    const plainCells  = playerCells.filter(c =>
      (!c.outputData || c.outputData === '0x') &&
      (!c.output.type)  // Skip cells with type scripts (e.g. old tournament escrow cells)
    )
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

    const outputs     = [{ capacity: `0x${depositCapacity.toString(16)}`, lock: destinationLock }]
    const outputsData = [marker]
    if (changeShannon >= changeMinShannon) {
      outputs.push({ capacity: `0x${changeShannon.toString(16)}`, lock: playerLock })
      outputsData.push('0x')
    }
    // else: change absorbed into fee (only happens if player barely has enough)

    // JoyID needs a WitnessArgs with a pre-allocated lock field (zeros) sized for its
    // WebAuthn secp256r1 signature. Without this the sighash can't be computed correctly.
    // WitnessArgs molecule: [full_size][offset0][offset1][offset2][lock_length][lock_zeros]
    // lock = BytesOpt::Some(300 zero bytes) — 300 is a safe upper-bound for JoyID's signature.
    const LOCK_SIZE = 300
    const WA_FULL = 20 + LOCK_SIZE  // 4 + 12 offsets + 4 Bytes length + LOCK_SIZE
    const waBuf = Buffer.alloc(WA_FULL)
    waBuf.writeUInt32LE(WA_FULL,   0)   // full_size
    waBuf.writeUInt32LE(16,        4)   // offset[0] — lock starts right after 16-byte header
    waBuf.writeUInt32LE(WA_FULL,   8)   // offset[1] — input_type starts at end (None)
    waBuf.writeUInt32LE(WA_FULL,  12)   // offset[2] — output_type starts at end (None)
    waBuf.writeUInt32LE(LOCK_SIZE, 16)  // lock Bytes length
    // bytes 20..WA_FULL are zero-initialised by Buffer.alloc
    const JOYID_WITNESS_PLACEHOLDER = '0x' + waBuf.toString('hex')
    const witnesses = inputs.map((_, i) => i === 0 ? JOYID_WITNESS_PLACEHOLDER : '0x')

    const rawTx = {
      version:     '0x0',
      cellDeps:    [...playerCellDeps],
      headerDeps:  [],
      inputs,
      outputs,
      outputsData,
      witnesses,
    }

    return { rawTx, dataMarker: marker }
  }

  /**
   * Build a JoyID sign URL using /sign-message with redirect delivery.
   *
   * JoyID's /sign-ckb-raw-tx and /sign-ckb both have broken redirect support
   * (hardcoded DappCommunicationType.Popup). However /sign-message fully supports
   * redirect — same as /auth which already works in our QR flow.
   *
   * Strategy:
   *   1. Build raw tx on server (buildPlayerDepositTx)
   *   2. Compute tx sighash via calculateChallenge (JoyID SDK)
   *   3. Player signs the challenge hash on /sign-message (redirect)
   *   4. Callback receives { signature, message, pubkey, keyType }
   *   5. buildSignedTx assembles the complete signed tx
   *   6. Submit to CKB
   *
   * @param {object} rawTx          - unsigned CKBTransaction from buildPlayerDepositTx
   * @param {string} playerAddress  - signer's CKB address
   * @param {string} callbackUrl    - local HTTP URL for JoyID redirect
   * @returns {string}  Short local URL (encode as QR)
   */
  async buildJoyIDSignTxUrl (rawTx, playerAddress, callbackUrl, { entryFeeCkb } = {}) {
    const joyidAppURL = this.isMainnet ? 'https://app.joy.id' : 'https://testnet.joyid.dev'
    const cbId = callbackUrl.split('/joyid/').pop().split('?')[0]

    // Compute the sighash that JoyID needs to sign.
    // witnessIndexes must include ALL inputs in the same lock group —
    // the on-chain script hashes all witnesses in the group, not just [0].
    const witnessIndexes = rawTx.inputs.map((_, i) => i)
    const rawTxClone = JSON.parse(JSON.stringify(rawTx))
    const challenge = await calculateChallenge(rawTxClone, witnessIndexes)
    console.log(`[AgentWallet] Tx challenge for signing: ${challenge}`)

    // Store the raw tx so the callback can assemble the signed version
    this._pendingRawTxs = this._pendingRawTxs || new Map()
    this._pendingRawTxs.set(cbId, rawTx)

    const request = {
      joyidAppURL,
      name:           'FiberQuest',
      challenge,
      isData:         false,
      address:        playerAddress,
      redirectURL:    callbackUrl,
      requestNetwork: 'nervos',
    }
    // /sign-message supports redirect — builds URL with type=redirect
    const joyidUrl = buildJoyIDSignMessageURL(request, 'redirect')
    console.log(`[AgentWallet] JoyID sign-message URL (first 200): ${joyidUrl.slice(0, 200)}`)
    return this.shortenUrl(joyidUrl, { cbId })
  }

  /**
   * Assemble a signed CKB transaction from the raw tx + JoyID sign-message response.
   * @param {string} cbId       - callback ID (links to stored raw tx)
   * @param {object} signedData - { signature, message, pubkey, keyType } from JoyID
   * @returns {object} signed CKBTransaction ready to submit
   */
  assembleSignedTx (cbId, signedData) {
    if (!this._pendingRawTxs?.has(cbId)) {
      throw new Error(`No pending raw tx for callback ${cbId}`)
    }
    const rawTx = this._pendingRawTxs.get(cbId)
    this._pendingRawTxs.delete(cbId)

    // JoyID redirect responses return signature + message as base64url,
    // but buildSignedTx expects raw hex (no 0x prefix). Convert if needed.
    const isHex = (s) => /^(0x)?[0-9a-f]*$/i.test(s)
    const normalized = { ...signedData }
    if (!isHex(normalized.signature)) {
      normalized.signature = base64urlToHex(normalized.signature)
    }
    if (!isHex(normalized.message)) {
      normalized.message = base64urlToHex(normalized.message)
    }
    // Strip 0x prefixes — buildSignedTx concatenates as raw hex
    if (normalized.pubkey?.startsWith('0x')) normalized.pubkey = normalized.pubkey.slice(2)
    if (normalized.signature?.startsWith('0x')) normalized.signature = normalized.signature.slice(2)
    if (normalized.message?.startsWith('0x')) normalized.message = normalized.message.slice(2)

    // Convert DER signature to IEEE P1363 (64 bytes fixed).
    // JoyID redirect returns DER from WebAuthn; on-chain lock expects IEEE.
    // mode(1) + pubkey(64) + sig_IEEE(64) = 129 = SECP256R1_PUBKEY_SIG_LEN
    if (normalized.signature.length !== 128) {  // 128 hex chars = 64 bytes IEEE
      const derBytes = Buffer.from(normalized.signature, 'hex')
      const rLen = derBytes[3]
      let r = derBytes.subarray(4, 4 + rLen).toString('hex')
      let s = derBytes.subarray(6 + rLen).toString('hex')
      r = r.length > 64 ? r.slice(-64) : r.padStart(64, '0')
      s = s.length > 64 ? s.slice(-64) : s.padStart(64, '0')
      normalized.signature = r + s
      console.log('[AgentWallet] Converted DER sig to IEEE P1363 (128 hex chars)')
    }

    console.log('[AgentWallet] keyType:', normalized.keyType,
                'pubkey len:', normalized.pubkey?.length,
                'sig len:', normalized.signature?.length,
                'msg len:', normalized.message?.length)

    const signed = buildSignedTx(rawTx, normalized, [0])
    // Verify mode byte
    const lockHex = signed.witnesses[0]
    console.log('[AgentWallet] witness lock (first 50):', lockHex?.slice(0, 50))
    return signed
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
    return this.sendL1BatchPayment([{ toAddress, amountCkb }])
  }

  /**
   * Send CKB on L1 to multiple recipients in a single transaction.
   * Avoids RBF conflicts when paying multiple players.
   * @param {Array<{toAddress: string, amountCkb: number}>} recipients
   * @returns {string} txHash
   */
  async sendL1BatchPayment (recipients) {
    const outputs = []
    const outputsData = []
    for (const { toAddress, amountCkb } of recipients) {
      const shannon = BigInt(Math.round(amountCkb * 1e8))
      outputs.push({ capacity: `0x${shannon.toString(16)}`, lock: utils.addressToScript(toAddress), type: null })
      outputsData.push('0x')
    }
    const signedTx = await this.buildAndSignTx({ outputs, outputsData })
    const txHash = await this.sendRawTx(signedTx)
    const summary = recipients.map(r => `${r.amountCkb} CKB → ${r.toAddress.slice(0, 20)}...`).join(', ')
    console.log(`[AgentWallet] L1 batch payment sent: ${summary} — tx: ${txHash}`)
    return txHash
  }
}

module.exports = { AgentWallet, depositDataMarker }
