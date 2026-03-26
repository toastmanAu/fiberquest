# FiberQuest Tournament v2 — Trustless Distributed Architecture

## Design Goals

- **Fiber-native:** Entry fees flow through Fiber channels, not raw L1 transfers
- **Participant protection:** Funds never leave player custody until channel escrow
- **No single point of failure:** TM can't steal funds, losers can't hold funds hostage
- **Block-deterministic:** All timing based on block numbers, not timestamps
- **Agent attestation:** Modified agents rejected at registration

---

## Roles

- **TM (Tournament Manager):** The FiberQuest agent hosting the tournament. Manages the tournament cell, coordinates registration, adjudicates scores. Runs a Fiber node.
- **PA (Participant Agent):** Each player's FiberQuest agent. Runs RetroArch, submits scores, opens Fiber channel to TM. Runs a Fiber node.

---

## Cell Types

### Tournament Cell (TC)
- **Lock:** TM's secp256k1 (only TM can consume/rewrite)
- **Type:** FiberQuest tournament type script (args = tournament ID)
- **Data:**
  ```json
  {
    "id": "tournament_xxxxx",
    "gameId": "mortal-kombat-snes",
    "modeId": "single_fight",
    "entryFee": 100,
    "playerCount": 4,
    "registeredPlayers": 0,
    "players": [],
    "entryCutoffBlock": 15234100,
    "startBlock": 15234120,
    "endBlock": 15234220,
    "state": "OPEN",
    "romHash": "DEF42945",
    "approvedAgentHashes": ["abc123...", "def456..."]
  }
  ```
- **States:** OPEN → ACTIVE → SETTLING → COMPLETE / CANCELLED

### Intent Cell (per participant)
- **Lock:** PA's own lock (PA owns it entirely)
- **Type:** FiberQuest intent type script
- **Data:**
  ```json
  {
    "tournamentId": "tournament_xxxxx",
    "playerAddress": "ckt1q...",
    "fiberPeerId": "QmXxx...",
    "agentCodeHash": "sha256:abcdef...",
    "createdAtBlock": 15234050
  }
  ```
- PA creates this to signal intent. Minimal CKB (62 CKB).
- PA consumes it themselves after being registered on TC.

### Score Cell (per participant, after game ends)
- **Lock:** PA's own lock
- **Type:** FiberQuest score type script (args = tournament ID)
- **Data:**
  ```json
  {
    "tournamentId": "tournament_xxxxx",
    "playerId": "player-0",
    "score": 2450,
    "koCount": 3,
    "eventLogHash": "sha256:...",
    "submittedAtBlock": 15234225
  }
  ```

---

## Full Flow

### Phase 1: Registration (OPEN state)

1. **Creator** clicks "Create Tournament" in FiberQuest UI
2. UI shows invoice breakdown:
   ```
   Entry Fee:          100 CKB
   On-chain costs:     ~X CKB (TC creation + N rewrites)
   ────────────────────────────
   Total:              100+X CKB
   ```
3. Creator signs via JoyID → pays to FiberQuest agent (TM)
4. TM creates Tournament Cell on-chain with creator as first expected player
5. **Other PAs discover TC** (via chain scan)
6. **PA creates intent cell** — signals "I want to join this tournament"
   - Data includes: tournament ID, Fiber peer ID, agent code hash
   - PA-locked — only PA can consume it
7. **TM scans for intent cells** every block (via BlockTracker)
   - Batches multiple found intents into one TC rewrite
   - Verifies agent code hash against approved list
   - Rejects unknown/modified agents
   - Rewrites TC: `registeredPlayers++`, adds player details to `players[]`
8. **PA sees itself on TC** → consumes own intent cell → opens Fiber channel to TM
   - Channel funded with entry fee CKB
   - Channel = pseudo-escrow (Fiber protocol enforces)
9. Repeat 6-8 until `playerCount` met or `entryCutoffBlock` reached

### Phase 2: Cutoff (entryCutoffBlock)

- **If playerCount met:** TM rewrites TC to ACTIVE-pending (waiting for startBlock)
- **If not enough players:** TM rewrites TC to CANCELLED
  - All open Fiber channels close cooperatively → CKB returned to PAs
  - No funds lost (minus standard Fiber channel tx fees)

### Phase 3: Game (startBlock → endBlock)

1. **startBlock reached** — all agents detect via BlockTracker
2. All agents start game simultaneously (block-deterministic, zero ambiguity)
3. RAM engines poll RetroArch, accumulate scores
4. **endBlock reached** — all agents stop simultaneously
5. Each PA writes a **score cell** to chain (PA-locked, PA writes it)

### Phase 4: Settlement (endBlock → endBlock + submissionWindow)

1. **Submission window** — N blocks for all score cells to confirm on chain
2. All agents scan for all score cells
3. **Every agent independently calculates winner** — deterministic formula on same data
4. All agents arrive at same answer

### Phase 5: Payout

1. **TM sends accumulated entry fees to winner via Fiber**
   - TM has entry fee CKB on its side of each channel
   - Sends total pot to winner's Fiber node (routed or direct)
2. **All channels close cooperatively**
   - Winner: receives entry fees from all losers via Fiber
   - Losers: channel closes with their balance (entry fee was sent to TM side)
   - TM: channel closes clean, no funds retained
3. **TC rewritten to COMPLETE** with winner + final scores

### Dispute / Non-cooperation

- **Loser's agent offline:** Fiber's built-in force-close handles this — TM can unilaterally close channel after timeout, claiming the entry fee that's on TM's side
- **TM offline after game:** Players can force-close their channels, recovering any funds still on their side. Worst case: entry fee stuck on TM side until TM comes back or channel times out
- **Score disagreement:** Shouldn't happen — all agents read same chain data, same formula. If an agent submits a fake score, other agents' scores still reflect reality and majority/deterministic rules apply
- **Modified agent:** Rejected at registration (code hash check)

---

## Agent Code Attestation

- Each PA includes `agentCodeHash` in their intent cell
- Hash covers the tournament logic: scoring formula, RAM engine, event detection
- TM maintains `approvedAgentHashes[]` in TC
- On discovery of intent cell, TM checks hash against approved list
- Unknown hash → intent ignored, PA not registered
- Protects against: modified scoring, fake event generation, RAM address tampering

---

## Block Timeline

```
Block N:        TC created (OPEN)
Block N+10:     Intent cells appearing, TM batching registrations
Block N+50:     entryCutoffBlock — registration closes
Block N+50..70: Fiber channels opening (PAs funding with entry fee)
Block N+70:     startBlock — game begins (all agents sync)
Block N+170:    endBlock — game ends (100 block duration)
Block N+180:    submissionDeadline — all scores on chain
Block N+185:    Payout via Fiber — winner receives pot
Block N+190:    TC → COMPLETE, channels closing
```

---

## Key Differences from v1

| Aspect | v1 (Hackathon) | v2 (This design) |
|--------|---------------|-------------------|
| Entry payment | JoyID L1 deposit to TM | Fiber channel (pseudo-escrow) |
| Fund custody | TM holds all funds | Fiber channels (shared custody) |
| Timing | Timestamps (drifty) | Block numbers (deterministic) |
| Payout | TM builds tx, hopes losers cooperate | Fiber sends (instant, no cooperation needed) |
| Agent trust | Implicit | Code hash attestation |
| Participant protection | Trust TM | Fiber protocol + chain-enforced |
| Score submission | TM reads local RAM | Each PA writes own score cell |
| Refund | Manual | Cooperative channel close |

---

## Open Questions

1. **Fiber channel open time:** How long does it take to open a channel + fund it? This affects the gap needed between cutoff and start blocks.
2. **Routing:** Can TM pay winner via multi-hop Fiber route, or must it be direct channel?
3. **Channel capacity:** Entry fee = channel funding. Minimum channel size on Fiber?
4. **Force-close timeout:** What's the default Fiber force-close delay? Affects dispute resolution time.
5. **Agent hash scope:** What exactly should be hashed? Full codebase vs just tournament-manager.js + ram-engine.js?
