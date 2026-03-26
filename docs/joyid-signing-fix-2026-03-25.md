# JoyID CKB Transaction Signing — Full Fix Documentation

**Date:** 2026-03-25
**Project:** FiberQuest (CKB AI Agent Hackathon)
**Status:** RESOLVED — full end-to-end payment flow working

---

## Problem Summary

Players needed to sign a CKB deposit transaction via JoyID (WebAuthn passkey wallet) on their phone by scanning a QR code. The agent builds the transaction, the player signs it, and the signed tx is submitted to CKB testnet. This flow failed for **two days** across multiple approaches before finally working.

---

## Root Cause Chain (4 Separate Issues)

### Issue 1: JoyID `/sign-ckb-raw-tx` Hardcodes Popup Delivery

**Symptom:** "Dapp window is closed, please reopen it and try again"

**Root Cause:** In JoyID's web bundle, the `useSignCkbRawTxToDapp` hook hardcodes `DappCommunicationType.Popup` in `sendMessageToDapp`. There is **no redirect code path** for `/sign-ckb-raw-tx`. The code:

```javascript
// JoyID bundle (minified, reconstructed)
if (cn === DappCommunicationType.Popup) {
  throw window.opener && window.opener.postMessage(sn, ln.origin),
    new Error("Dapp window is closed, please reopen it and try again")
}
```

This always throws. With `window.opener = null` (which happens for cross-origin http→https on iOS Safari), the postMessage is skipped and the signed tx is lost.

**Attempted workarounds that failed:**
- Bridge page with `window.open()` — iOS Safari nulls `window.opener` for cross-origin popups
- SSE keepalive to prevent iOS tab suspension — `window.opener` still null
- `commuType: 'redirect'` in request data — suppresses the 5-second UI warning in LogoShell but does NOT change `sendMessageToDapp` delivery mechanism
- `/sign-ckb` route — also showed "FiberQuest window has been closed" error

**Solution:** Abandoned `/sign-ckb-raw-tx` entirely. Switched to `/sign-message` which has proper redirect support (SDK exports `signMessageWithRedirect`).

---

### Issue 2: JoyID Testnet Cell Dep Consumed

**Symptom:** `TransactionFailedToResolve: Unknown(OutPoint(0x4dcf3f3b...))`

**Root Cause:** The JoyID dep_group cell at `0x4dcf3f3b09efac8995d6cbee87c5345e812d310094651e0c3d9a730f32dc9263:0x0` was consumed/spent on testnet. The `@joyid/ckb` SDK v1.1.4 still references this dead cell. The JoyID code itself is still deployed — just in different cells.

**Solution:** Switched from single dep_group to 5 individual code deps (CCC SDK style), found by querying live cells via their Type IDs:

```javascript
const JOYID_DEPS_TESTNET = [
  { outPoint: { txHash: '0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9', index: '0x0' }, depType: 'code' },
  { outPoint: { txHash: '0x4a596d31dc35e88fb1591debbf680b04a44b4a434e3a94453c21ea8950ffb4d9', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0xf2c9dbfe7438a8c622558da8fa912d36755271ea469d3a25cb8d3373d35c8638', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x95ecf9b41701b45d431657a67bbfa3f07ef7ceb53bf87097f3674e1a4a19ce62', index: '0x1' }, depType: 'code' },
  { outPoint: { txHash: '0x8b3255491f3c4dcc1cfca33d5c6bcaec5409efe4bbda243900f9580c47e0242e', index: '0x1' }, depType: 'code' },
]
```

**Key detail:** The CKB-AI MCP docs listed these cells at index `0x0`, but they're actually at index `0x1` (verified via `get_live_cell` RPC). Only `0x4a596d31...` has cells at both `0x0` and `0x1`.

---

### Issue 3: Base64url vs Hex Encoding in Redirect Response

**Symptom:** `ValidationFailure: error code 8` (invalid unlock mode byte)

**Root Cause:** JoyID's redirect response returns `signature` and `message` fields as **base64url-encoded** strings, while the SDK's `buildSignedTx` expects **hex** strings. The popup response returns hex. This encoding difference is undocumented.

```
// Redirect response (base64url):
signature: "MEUCIQCPXArrfP62kqyz..."   // base64url (NOT hex!)
message:   "K4sF4fAwPvuJj-TW3mAR..."   // base64url (NOT hex!)
pubkey:    "a2c933b0689ebe57d986..."     // hex (correct)
```

When `buildSignedTx` concatenates `0x${mode}${pubkey}${signature}${message}`, the base64url strings produce garbage bytes. The first byte of the lock field was `0x00` instead of `0x01` (unlock mode), causing error 8.

**Solution:** Convert base64url fields to hex using `base64urlToHex` from `@joyid/common` before passing to `buildSignedTx`. Also convert DER signature to IEEE P1363 format (64 bytes fixed):

```javascript
// base64url → hex
if (!isHex(normalized.signature)) {
  normalized.signature = base64urlToHex(normalized.signature)
}
if (!isHex(normalized.message)) {
  normalized.message = base64urlToHex(normalized.message)
}

// DER → IEEE P1363 (72 bytes variable → 64 bytes fixed)
if (normalized.signature.length !== 128) { // 128 hex = 64 bytes
  const derBytes = Buffer.from(normalized.signature, 'hex')
  const rLen = derBytes[3]
  let r = derBytes.subarray(4, 4 + rLen).toString('hex')
  let s = derBytes.subarray(6 + rLen).toString('hex')
  r = r.length > 64 ? r.slice(-64) : r.padStart(64, '0')
  s = s.length > 64 ? s.slice(-64) : s.padStart(64, '0')
  normalized.signature = r + s
}
```

---

### Issue 4: `isData: true` vs `isData: false` — THE FINAL FIX

**Symptom:** `ValidationFailure: error code 12` (challenge not found in WebAuthn ClientData)

**Root Cause:** The `isData` flag in the JoyID sign-message request controls how the challenge string is passed to WebAuthn:

- `isData: false` — challenge is a **UTF-8 string** (the hex string itself, 64 ASCII bytes)
- `isData: true` — challenge is **hex-decoded binary** (32 raw bytes)

The JoyID on-chain lock script computes its sighash (32 bytes), **hex-encodes** it to a 64-char string, then passes that string through WebAuthn's base64url encoding to search in the clientDataJSON.

With `isData: true`: clientDataJSON has `base64url(32 raw bytes)` = 43 chars
With `isData: false`: clientDataJSON has `base64url(utf8("fa1b0a8f..."))` = ~86 chars

The on-chain script searches for the ~86-char version. With `isData: true`, only the 43-char version exists → **not found → error 12**.

In the SDK's own `signChallenge` function:
```javascript
const isData = typeof challenge !== "string"  // false for hex strings!
```

Since `calculateChallenge` returns a hex **string**, `isData` is always `false` in the normal flow. We incorrectly set it to `true`.

**Solution:** Change `isData: true` to `isData: false` in the sign-message request.

---

## JoyID Lock Script Error Codes Reference

| Code | Meaning |
|------|---------|
| 6 | Public key hash from witness does not match script args |
| 7 | Witness length is invalid |
| 8 | Unlock mode in witness is invalid (must be 0x01 main key or 0x02 sub key) |
| 11 | Secp256r1 signature verification failed |
| 12 | Calculated challenge (sigHashAll) not found in WebAuthn ClientData |
| 13 | CoTA SMT root from cell dep is invalid |
| 14 | Sub key SMT proof verification failed |
| 21 | CoTA cell lock script from cell deps does not match |

Source: https://docs.joyid.dev/guide/ckb/smart-contract

---

### Issue 5: Multi-Input witnessIndexes Mismatch

**Symptom:** `ValidationFailure: error code 12` — but ONLY when player has 2+ input cells (worked fine with 1 input)

**Root Cause:** `calculateChallenge(rawTx, [0])` only hashes witness[0] in the sighash. But the on-chain JoyID lock script hashes ALL witnesses in the same lock group (all inputs sharing the same lock script). When the player needed 2 cells to cover the 100 CKB entry fee, witness[1] was included on-chain but missing from our computation.

This was intermittent because it depended on the player's UTXO set — players with a single large cell worked (1 input = 1 witness), but players whose cells had been split by previous deposits needed 2 inputs and failed.

**Solution:** Pass all input indices as witnessIndexes:

```javascript
const witnessIndexes = rawTx.inputs.map((_, i) => i)
const challenge = await calculateChallenge(rawTx, witnessIndexes)
```

### Issue 6: Chain State TX Replacing Payout TX (RBF)

**Symptom:** Payout tx accepted then `RBFRejected: replaced by tx...` — players never received CKB

**Root Cause:** `completeTournament()` chain state update fired immediately after the payout tx, consuming the same agent wallet cells. The higher-fee chain state tx replaced the payout in the mempool.

**Solution:** Disabled chain state updates during settlement/payout. Batch all player payouts into a single transaction via `sendL1BatchPayment()`.

---

## Final Working Architecture

```
Player Phone                    FiberQuest Agent                CKB Testnet
─────────────                   ────────────────                ───────────

1. Scan Connect QR ──────────→ /auth (redirect) ←──────── JoyID testnet
   JoyID auth ←─────────────── callback: { address, pubkey }

2. Agent builds raw deposit tx  buildPlayerDepositTx()
   (player inputs → agent addr  calculateChallenge(rawTx)
    + data marker)              → sighash hex string

3. Scan Sign QR ─────────────→ /sign-message (redirect)
   WebAuthn Face ID             challenge = sighash (isData:false)
   JoyID signs ←───────────── callback: { signature, message, pubkey, keyType }

4.                              base64url→hex conversion
                                DER→IEEE P1363 sig conversion
                                buildSignedTx(rawTx, signedData)
                                sendRawTx(signedTx) ──────────→ submit tx

5.                              pollForDepositByMarker() ←──── confirmed!
                                markPaid(playerId)
                                → tournament auto-starts
```

## Key SDK Functions Used

| Function | Package | Purpose |
|----------|---------|---------|
| `buildJoyIDSignMessageURL` | `@joyid/common` | Build /sign-message URL with redirect support |
| `calculateChallenge` | `@joyid/ckb` | Compute tx sighash (129-byte zero lock placeholder) |
| `buildSignedTx` | `@joyid/ckb` | Assemble signed witness from sign-message response |
| `base64urlToHex` | `@joyid/common` | Convert redirect response fields to hex |
| `decodeSearch` | `@joyid/common` | Decode JoyID's QSS-encoded `_data_` param |

## Key Technical Facts

- **JoyID lock sighash:** Uses `SECP256R1_PUBKEY_SIG_LEN = 129` byte zero placeholder (mode 1 + pubkey 64 + sig 64), NOT the actual lock field length. This is different from the standard secp256k1 approach.
- **JoyID witness lock format:** `mode(1) + pubkey(64) + sig_IEEE(64) + message(N)` where N = authenticatorData(37) + clientDataJSON(~137)
- **WebAuthn challenge encoding:** The on-chain script expects the sighash to be the hex string passed as UTF-8 bytes to WebAuthn (`isData: false`), NOT raw binary bytes.
- **Redirect vs Popup response format:** Redirect returns base64url for signature/message fields; popup returns hex. Both return hex for pubkey.

## Files Modified

- `src/agent-wallet.js` — JoyID callback server, sign URL builder, witness assembly
- `src/tournament-manager.js` — Player payment flow orchestration

## Verified On-Chain Transactions (CKB Testnet, March 25 2026)

- Phill1: `0xea2d10797654265096b6a99179240908b84ae9acb5696ef9679374db473b4faa`
- Phill2: `0x3df5ff04b579652b4d165a44a7eb85189cf5831116c4ee2d33fa089af80800ad`
