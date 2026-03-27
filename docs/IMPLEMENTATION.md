# FiberQuest — Implementation Backlog

Tracking pending features, plumbing gaps, and post-hackathon work.
Ordered roughly by priority. Items marked `[HACKATHON]` are needed before March 25.

---

## 1. Agent Configuration — Setup Page Addition `[HACKATHON]`

The Setup view needs a new "Agent" section so organizers can power the on-chain agent
without setting env vars manually.

**Fields needed:**

| Field | Notes |
|-------|-------|
| CKB Private Key | Hex, 64 chars. Powers escrow cell creation + chain state updates. Store in Electron `safeStorage` (encrypted at rest), never in plaintext. |
| CKB RPC URL | Default: `https://testnet.ckbapp.dev/`. Override for local node or light client. |
| Fiber RPC URL | Default: `http://127.0.0.1:18226`. Should auto-detect if tunnel is up. |
| Settlement Buffer | Seconds after game ends before payout fires. Default 30s. |
| Registration Window | Minutes players have to enter after tournament is created. Default 10 min. |

**Implementation path:**
- Add "Agent" collapsible section to `renderer/index.html` Setup view
- IPC: `ipcRenderer.invoke('agent:config', {...})` → `main.js` stores via `safeStorage`
- `main.js` loads config on startup, passes to `TournamentManager({ wallet: new AgentWallet(key) })`
- Show agent wallet address + CKB balance on Home view once key is set
- Warning banner if `CKB_PRIVATE_KEY` not set: "On-chain features disabled — add key in Setup"

**Files:** `renderer/index.html`, `src/main.js`, `src/preload.js`

---

## 2. Local Inference Endpoint `[POST-HACKATHON]`

For future AI-powered features (score prediction, anti-cheat, tournament commentary).

**Fields:**
| Field | Notes |
|-------|-------|
| Inference URL | e.g. `http://192.168.68.79:11434` (Ollama on NucBox) |
| Model | e.g. `llama3`, `mistral` |
| API Key | Optional, for cloud fallback (OpenRouter etc.) |

**Planned uses:**
- Auto-generate tournament descriptions from game + mode
- Post-game commentary ("Alice won 3-0 in 4 mins — dominant performance")
- Anomaly detection on RAM scores (flag suspicious score jumps)
- Shannon/Kernel agent integration via RAG + OpenClaw agentPay skill

**Files:** `src/inference-client.js` (new), `renderer/index.html`

---

## 3. Tournament Browser — Home View `[HACKATHON]`

Currently Home view shows Fiber node status. Add a "Live Tournaments" panel that
scans the chain and shows open/active tournaments from any FiberQuest instance.

**UI:**
```
┌─ LIVE TOURNAMENTS ──────────────────────────────────────────────┐
│  🟢 Tetris NES — Highest Score     2/4 players   10 CKB entry  │
│  🟡 Mortal Kombat — Best of 3      ACTIVE        Ends in 3:42   │
│  🔴 Super Mario — Speedrun         SETTLING      Paying out...  │
└─────────────────────────────────────────────────────────────────┘
```

**Implementation:**
- `TournamentManager.scanChain()` on startup + every 30s
- Filter by state: show ESCROW (open), ACTIVE, SETTLING
- "Join" button on ESCROW tournaments → generates entry invoice
- Requires knowing the agent's lock args — either from local config or a well-known
  FiberQuest "registry" address (future: on-chain registry cell)

**Problem to solve:** scanChain() currently only scans one lock args (the local agent).
To find tournaments from *other* FiberQuest instances, need either:
- A shared well-known registry address all instances write to
- Or a gossip/discovery mechanism (post-hackathon)
- Short-term: hardcode the hackathon demo address in config

**Files:** `renderer/index.html`, `src/main.js`, `src/chain-store.js`

---

## 4. Registration Deadline UI `[HACKATHON]`

The live countdown to registration close is missing from the UI.

**Needed:**
- Setup view: "Registration window" field (minutes, default 10)
- After tournament created: show countdown timer "Registration closes in 8:42"
- On deadline: show "Starting!" (min met) or "Cancelled — refunding" (min not met)
- Emit `registration_closed` / `cancelled` events → IPC → renderer

**Files:** `renderer/index.html`, `src/main.js` (IPC handlers)

---

## 5. Settlement Buffer UI `[HACKATHON]`

After game ends, players see a "Settling..." screen during the buffer period.

**Needed:**
- Results view: add SETTLING state between ACTIVE and COMPLETE
- Show countdown: "Finalising result — paying out in 28s"
- On-chain tx hash shown once COMPLETE: "Paid ✓ — tx: 0xabc..."
- `settling` event already emitted from TournamentManager — just need IPC + renderer

**Files:** `renderer/index.html`, `src/main.js` (wire `settling` event to IPC)

---

## 6. Fiber Refund Flow — Cancelled Tournaments `[HACKATHON]`

When a tournament is cancelled (min players not met), entry fees need returning.

**Current state:** `_checkRegistrationDeadline()` sets state to CANCELLED and updates
chain cell, but does NOT refund entry fees.

**Implementation needed in `tournament-manager.js`:**
```js
// In _checkRegistrationDeadline, after CANCELLED:
for (const [pid, player] of Object.entries(t.players)) {
  if (!player.paid) continue
  if (player.payoutInvoice) {
    // Refund via player's payout invoice
    await t.fiber.sendPayment(player.payoutInvoice, { amount: entryFeeShannon })
  } else {
    t.emit('refund_needed', { playerId: pid, name: player.name, amount_ckb: t.entryFee })
  }
}
```

Note: Requires players to have submitted a payout invoice at registration time,
or a manual refund flow. Consider making payout invoice mandatory for entry.

**Files:** `src/tournament-manager.js`

---

## 7. Chain Cell Consumption — Cleanup `[POST-HACKATHON]`

COMPLETE and CANCELLED cells currently stay on-chain forever. The agent should
consume them to reclaim the CKB capacity.

**When to consume:**
- COMPLETE: after payout confirmed (add delay for safety)
- CANCELLED: after all refunds sent

**Implementation:** `ChainStore.consumeCell(outPoint)` already exists.
Just needs to be called from the right place in `tournament-manager.js`.

---

## 8. Secure Key Storage `[HACKATHON]`

Currently CKB_PRIVATE_KEY is a plaintext env var. For the app:

- Use Electron's `safeStorage.encryptString()` / `decryptString()` to store key
- Never log the key, never include in IPC payloads sent to renderer
- Key entry in Setup: password-style input, show derived address as confirmation
- Add `scripts/derive-address.js` helper: `node scripts/derive-address.js <privkey>` → prints address

**Files:** `src/main.js`, `renderer/index.html`

---

## 9. Multi-Instance Tournament Discovery `[POST-HACKATHON]`

Currently tournaments are only visible to instances that know the organizer's lock args.

**Options (in order of complexity):**
1. **Hardcoded demo address** — simple for hackathon, not scalable
2. **On-chain registry cell** — one well-known cell lists all active organizer addresses
3. **Fiber gossip** — broadcast tournament announcements over Fiber peer network
4. **Shannon/Kernel scan** — agents periodically scan known addresses and publish to RAG

For hackathon: option 1 (hardcode the demo address, make it configurable in Setup).

---

## 10. Standalone Payout Agent `[POST-HACKATHON]`

Extract payout logic from Electron app into a standalone service that can run
on the same machine as the Fiber node.

**Design:**
```
fiberquest-agent.service (systemd)
  ├── Watches chain for tournament cells (poll every 30s)
  ├── Manages registration deadlines
  ├── Drives game start / RAM engine
  └── Executes Fiber payouts autonomously
```

**OpenClaw integration:**
- Register as an agentPay-compatible OpenClaw skill
- Shannon/Kernel can trigger tournament creation via skill call
- Results published to RAG for agent queryability

**Files:** `src/agent.js` (new standalone entrypoint), systemd unit file

---

## 11. CLAUDE.md Updates Needed

- Add `CKB_PRIVATE_KEY` env var to Live Infrastructure section
- Update SSH tunnel section: canonical tunnel is `18226 → N100:8226`
- Add chain-store + agent-wallet to Key Files list
- Update Current Status to v0.1.0

---

_Last updated: 2026-03-23_
_Version target: v0.1.0 (hackathon) → v0.2.0 (standalone agent)_
