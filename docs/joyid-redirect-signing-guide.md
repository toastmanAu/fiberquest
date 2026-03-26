# JoyID CKB Transaction Signing via Redirect — Undocumented Issues & Workarounds

**Context:** Cross-device QR signing flow (desktop builds tx, mobile phone signs via JoyID)
**SDK Version:** `@joyid/ckb@1.1.4`, `@joyid/common`
**Chain:** CKB Testnet (Pudge)
**Date:** March 2026

---

## Background

The JoyID SDK is designed for browser popup flows — the dapp opens JoyID in a popup, JoyID signs, and returns the result via `window.opener.postMessage`. This works when the dapp and JoyID run in the same browser.

For cross-device flows (e.g. a desktop Electron app showing QR codes that a mobile phone scans), popups don't work because `window.opener` is null across devices. The redirect flow (`type=redirect`) is needed instead, where JoyID redirects the phone's browser back to a callback URL with the signed data.

JoyID's `/auth` and `/sign-message` routes support redirect. The CKB transaction signing routes (`/sign-ckb-raw-tx`, `/sign-ckb`) do not. This document describes how to sign CKB transactions via the `/sign-message` redirect path and the undocumented issues encountered.

---

## Architecture: sign-message as CKB Transaction Signer

Since `/sign-ckb-raw-tx` doesn't support redirect, the workaround is:

1. **Build the raw CKB transaction** on the server (input selection, outputs, witnesses)
2. **Compute the sighash** using `calculateChallenge()` from `@joyid/ckb`
3. **Send the sighash** to JoyID's `/sign-message` route (which supports redirect)
4. **Receive the WebAuthn signature** via redirect callback
5. **Assemble the signed witness** using `buildSignedTx()` from `@joyid/ckb`
6. **Submit** the complete signed transaction to CKB

```
Phone scans QR → /sign-message?type=redirect → WebAuthn → redirect to callback
                                                              ↓
Server: calculateChallenge(rawTx) ←→ buildSignedTx(rawTx, signedData) → sendRawTx()
```

---

## Issue 1: `/sign-ckb-raw-tx` Hardcodes Popup Delivery

**Symptom:** `"Dapp window is closed, please reopen it and try again"`

The JoyID web app's `useSignCkbRawTxToDapp` hook hardcodes `DappCommunicationType.Popup` in `sendMessageToDapp`, regardless of the `type` URL parameter or `commuType` in the request data. There is no redirect code path for transaction signing.

The `/sign-ckb` route has the same issue despite `useSendCkbTransactionToServer` reading `commuType` — the page-level checks still block when `window.opener` is null.

**Workaround:** Use `/sign-message` with redirect instead. Build the URL with:
```javascript
const { buildJoyIDSignMessageURL } = require('@joyid/common')
const url = buildJoyIDSignMessageURL(request, 'redirect')
```

---

## Issue 2: Redirect Response Returns Base64url, Not Hex

**Symptom:** `ValidationFailure: error code 8` (invalid unlock mode byte)

The popup flow returns `signature` and `message` fields as hex strings. The redirect flow returns them as **base64url-encoded** strings. The `pubkey` field is hex in both cases. This encoding difference is undocumented.

When passed directly to `buildSignedTx()`, the base64url strings are concatenated as if they were hex, producing a malformed witness.

**Workaround:** Detect and convert before calling `buildSignedTx`:
```javascript
const { base64urlToHex } = require('@joyid/common')

const isHex = (s) => /^(0x)?[0-9a-f]*$/i.test(s)
if (!isHex(signedData.signature)) {
  signedData.signature = base64urlToHex(signedData.signature)
}
if (!isHex(signedData.message)) {
  signedData.message = base64urlToHex(signedData.message)
}
```

---

## Issue 3: DER Signature Must Be Converted to IEEE P1363

**Symptom:** `ValidationFailure: error code 8` (invalid unlock mode) or `error code 12` (challenge not found)

WebAuthn returns ECDSA signatures in DER format (variable length, typically 70-72 bytes). The JoyID on-chain lock script expects IEEE P1363 format (fixed 64 bytes: 32-byte r + 32-byte s). The SDK has an internal `derToIEEE()` function but does not export it.

The witness lock format is: `mode(1) + pubkey(64) + sig_IEEE(64) + message(N)`. With a DER signature (72 bytes), the parser reads wrong bytes for the message, causing error 8 (mode byte shifted) or error 12 (message/clientDataJSON corrupted).

**Workaround:** Convert DER to IEEE P1363 after base64url→hex conversion:
```javascript
if (signature.length !== 128) { // 128 hex chars = 64 bytes IEEE
  const der = Buffer.from(signature, 'hex')
  const rLen = der[3]
  let r = der.subarray(4, 4 + rLen).toString('hex')
  let s = der.subarray(6 + rLen).toString('hex')
  r = r.length > 64 ? r.slice(-64) : r.padStart(64, '0')
  s = s.length > 64 ? s.slice(-64) : s.padStart(64, '0')
  signature = r + s // Now exactly 128 hex chars = 64 bytes
}
```

---

## Issue 4: `isData` Flag Controls WebAuthn Challenge Encoding

**Symptom:** `ValidationFailure: error code 12` (challenge not found in WebAuthn ClientData)

The `isData` field in the sign-message request controls how JoyID passes the challenge to WebAuthn:

| `isData` | WebAuthn receives | clientDataJSON challenge | Bytes |
|----------|-------------------|------------------------|-------|
| `true` | hex-decoded binary | `base64url(32 raw bytes)` | 43 chars |
| `false` | UTF-8 string of hex | `base64url(64 ASCII bytes)` | 86 chars |

The on-chain JoyID lock script computes its sighash and searches for it in the clientDataJSON. The encoding must match what the script expects.

**Key finding:** The SDK's `signChallenge()` sets `isData = typeof challenge !== "string"`. Since `calculateChallenge()` returns a hex string, `isData` is `false` in the normal SDK flow.

**Workaround:** Match the SDK's behavior — set `isData: false` when the challenge is a hex string:
```javascript
const request = {
  challenge: hexSighash,  // from calculateChallenge()
  isData: false,          // challenge is a hex STRING, not binary
  // ...
}
```

---

## Issue 5: `witnessIndexes` Must Include All Inputs in Lock Group

**Symptom:** `ValidationFailure: error code 12` — but only when the player's transaction has 2+ inputs

The CKB sighash computation includes ALL witnesses in the same lock script group. If a player needs 2 input cells to cover the entry fee, both witnesses must be included in the hash. However, `calculateChallenge(tx, [0])` only processes witness[0].

This is an intermittent failure — it works when the player has a single large UTXO but fails when they have multiple smaller cells. After several tournament cycles deplete the player's large cells, they switch to multi-input transactions and signing breaks.

**Workaround:** Pass all input indices that share the same lock script:
```javascript
// Simple case: all inputs are from the same player (same lock)
const witnessIndexes = rawTx.inputs.map((_, i) => i)
const challenge = await calculateChallenge(rawTx, witnessIndexes)
```

For mixed-lock transactions, filter to only inputs matching the signer's lock:
```javascript
const signerLock = utils.addressToScript(playerAddress)
const witnessIndexes = rawTx.inputs
  .map((inp, i) => i)
  .filter(i => {
    const cell = inputCells[i]
    return cell.lock.codeHash === signerLock.codeHash && cell.lock.args === signerLock.args
  })
```

---

## Issue 6: Testnet Cell Dependencies Are Stale in SDK

**Symptom:** `TransactionFailedToResolve: Unknown(OutPoint(0x4dcf3f3b...))`

The `@joyid/ckb` SDK v1.1.4 references a dep_group cell `0x4dcf3f3b09efac8995d6cbee87c5345e812d310094651e0c3d9a730f32dc9263:0x0` that has been consumed on CKB testnet. The JoyID code is still deployed but in different cells.

**Workaround:** Use 5 individual code deps (CCC SDK style) instead of the dep_group. Find them by querying live cells via their Type IDs:

```javascript
const JOYID_DEPS_TESTNET = [
  { outPoint: { txHash: '0x4a596d31...', index: '0x0' }, depType: 'code' },
  { outPoint: { txHash: '0x4a596d31...', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0xf2c9dbfe...', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x95ecf9b4...', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x8b325549...', index: '0x1' }, depType: 'code' },
]
```

To find current deps, query by Type ID:
```javascript
const TYPE_ID = '0x00000000000000000000000000000000000000000000000000545950455f4944'
// Type IDs for JoyID testnet:
// 0x1c9fc299..., 0x27f0d3cc..., 0x0ac15fe5..., 0xc7bafc55..., 0x71decef9...
const result = await rpc('get_cells', [{
  script: { code_hash: TYPE_ID, hash_type: 'type', args: typeId },
  script_type: 'type'
}, 'desc', '0x1'])
```

**Note:** The CKB-AI MCP documentation lists some cells at index `0x0` but the actual live cells are at `0x1`. Always verify with `get_live_cell`.

---

## Complete Working Example

```javascript
const { buildJoyIDSignMessageURL, base64urlToHex } = require('@joyid/common')
const { calculateChallenge, buildSignedTx } = require('@joyid/ckb')

// 1. Build raw transaction (server-side)
const rawTx = await buildPlayerDepositTx(playerAddress, tournamentId, slot, fee)

// 2. Compute sighash — include ALL input witnesses
const witnessIndexes = rawTx.inputs.map((_, i) => i)
const challenge = await calculateChallenge(rawTx, witnessIndexes)

// 3. Build JoyID sign-message URL (redirect mode)
const request = {
  joyidAppURL: 'https://testnet.joyid.dev',
  name: 'MyApp',
  challenge,
  isData: false,        // MUST be false for hex string challenges
  address: playerAddress,
  redirectURL: callbackUrl,
  requestNetwork: 'nervos',
}
const joyidUrl = buildJoyIDSignMessageURL(request, 'redirect')
// Show as QR code for mobile scanning

// 4. In callback handler — normalize the redirect response
const signedData = { ...payload }

// Convert base64url → hex
const isHex = (s) => /^(0x)?[0-9a-f]*$/i.test(s)
if (!isHex(signedData.signature)) signedData.signature = base64urlToHex(signedData.signature)
if (!isHex(signedData.message)) signedData.message = base64urlToHex(signedData.message)

// Strip 0x prefixes
for (const k of ['pubkey', 'signature', 'message']) {
  if (signedData[k]?.startsWith('0x')) signedData[k] = signedData[k].slice(2)
}

// Convert DER → IEEE P1363
if (signedData.signature.length !== 128) {
  const der = Buffer.from(signedData.signature, 'hex')
  const rLen = der[3]
  let r = der.subarray(4, 4 + rLen).toString('hex')
  let s = der.subarray(6 + rLen).toString('hex')
  r = r.length > 64 ? r.slice(-64) : r.padStart(64, '0')
  s = s.length > 64 ? s.slice(-64) : s.padStart(64, '0')
  signedData.signature = r + s
}

// 5. Assemble and submit
const signedTx = buildSignedTx(rawTx, signedData, [0])
const txHash = await rpc.sendTransaction(signedTx, 'passthrough')
```

---

## JoyID Lock Script Error Code Reference

| Code | Meaning | Likely Cause in Redirect Flow |
|------|---------|-------------------------------|
| 7 | Invalid witness length | base64url not converted to hex |
| 8 | Invalid unlock mode (not 0x01/0x02) | DER signature not converted to IEEE, or base64url corruption |
| 11 | Secp256r1 signature verification failed | Wrong signature bytes |
| 12 | Challenge not found in ClientData | `isData` wrong, or `witnessIndexes` incomplete |

---

## Summary

The JoyID SDK's redirect path for CKB transaction signing requires 5 undocumented transformations:

1. Route via `/sign-message` (not `/sign-ckb-raw-tx`)
2. Convert response fields from base64url to hex
3. Convert DER signature to IEEE P1363
4. Set `isData: false` for hex string challenges
5. Include all lock group inputs in `witnessIndexes`

Missing any single step produces a valid-looking transaction that fails on-chain with an opaque error code.
