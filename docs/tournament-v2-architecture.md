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

1. **All agents independently calculate winner** (deterministic, same chain scores)
2. **Each losing agent voluntarily sends entry fee to TM via Fiber** (~20ms per hop)
   - Agent code attestation ensures approved agents always honour results
3. **TM forwards accumulated pot to winner via Fiber** (~20ms)
   - Total payout time: **under 1 second**
   - TM acts as hub router — CKB flows through, never held
4. **All channels close cooperatively** — standard Fiber close
5. **TC rewritten to COMPLETE** with winner + final scores

### Scaling Path
- **Current:** CKB L1 testnet — free, sufficient throughput for tournament frequency
- **Future:** If FiberQuest grows, migrate to L2 appchain with sub-second blocks
  and near-zero fees. Cell model + tournament logic translates directly.
  Mainnet pathway is likely its own appchain, not raw L1.

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

## Agent Wallet UX

The agent's private key generates both an L1 CKB address and an implicit Fiber wallet. To the user, this appears as a single "gaming wallet" they top up and maintain a float in.

### Wallet Page (new view in FiberQuest UI)
- **Total balance:** L1 cells + Fiber channel balances combined
- **Available:** L1 CKB ready for new tournaments / channel funding
- **In channels:** CKB locked in active Fiber channel escrows
- **Suggested float:** Calculated from typical entry fee + cell operation costs
- **History:** Tournament entries, payouts, channel opens/closes, cell creates/consumes
- **Top up:** JoyID deposit (existing flow)

### How it works
- User tops up agent wallet via JoyID (L1 deposit)
- Agent autonomously manages:
  - Creating intent cells (registration)
  - Opening/funding Fiber channels (entry fee escrow)
  - Creating score cells (result submission)
  - Consuming cells when no longer needed (reclaim CKB)
- User never manually manages cells or channels
- Suggested float: `(typical_entry_fee × 2) + (cell_costs × 5)` — enough for 2 concurrent tournaments with headroom

### Setup
- One-time: "Generate Agent Wallet" or "Import Key" in settings
- After setup, wallet tab is the primary interface
- Agent PK derives both secp256k1 lock (L1) and Fiber node identity

---

## Validation Against CKB Docs — Holes & Issues Found

### Issue 1: Intent Cell Capacity Is NOT Minimal
Doc says "Minimum: 61 CKBytes for an empty cell." But our intent cell has:
- Lock script: ~53 bytes (secp256k1)
- Type script: ~65 bytes (code_hash + hash_type + args)
- Data: ~200 bytes (tournament ID, address, peer ID, code hash)
- **Total: ~380 bytes = ~380 CKB locked just to signal intent**

This isn't "minimal" — it's significant. PA gets it back when they consume it, but they need 380 CKB upfront *on top of* their entry fee. The agent float needs to account for this.

**Mitigation:** Factor into suggested float calculation. Intent cell CKB is fully reclaimable.

### Issue 2: TC Rewrite Race Condition
If TM tries to batch-rewrite the TC but the outpoint was already consumed by a prior rewrite (e.g., two rewrites in quick succession), the tx will fail with "dead cell."

**Mitigation:** TM must handle `OutPointAlreadySpent` errors and retry with fresh outpoint from `scanTournaments()`. Standard CKB pattern — retry on stale outpoint.

### Issue 3: Fiber Channel Funding Is Two L1 Transactions
PA flow: consume intent cell (tx 1) → CKB to wallet → open_channel (tx 2, funding tx on-chain). Each needs ~10s block confirmation. Total: ~20-30s per channel.

**Mitigation:** All PAs open channels in parallel (not sequential). Gap between cutoffBlock and startBlock needs to be at least ~30 blocks (~5 min) to allow all channels to confirm.

### Issue 4: Payout Routing — The Channel Balance Problem
This is the biggest hole. After entry fee payments:
- TM has 100 CKB on TM-side of each channel
- But Fiber channels are point-to-point
- TM can only send CKB *back through the same channel* to the same PA
- TM cannot directly move Player B's entry fee to Player A

**Options:**
a) **Multi-hop routing**: If Fiber supports routing payments through TM (A→TM→B), TM could route the payout. But the direction is wrong — we need TM→Winner, using funds from Loser's channel.
b) **TM closes losing channels first (L1)**: Close loser channels → CKB returns to TM's L1 wallet → TM sends L1 payment to winner. Slower but guaranteed.
c) **Pre-funded TM**: TM maintains a Fiber float. TM pays winner from its own balance immediately, then recoups from closing loser channels later. Requires TM to have liquidity.
d) **Dual-funded channels**: Both TM and PA fund the channel. TM pre-loads its side with enough to cover potential payout. Complex.

**Resolved: Hub routing via voluntary send.** Since all agents run deterministic code and the outcome is verifiable on-chain, losing agents voluntarily send their entry fee to TM via Fiber (~20ms), and TM forwards to winner (~20ms). Total payout: <1 second. TM is a router, not a holder — CKB flows through, not to. No pre-funded float needed. Modified agents that refuse to send are prevented by code attestation at registration. TM maintains a modest operational float (~400 CKB) for cell operations only.

### Issue 5: What If PA Doesn't Open Channel After Registration?
TM registered them on TC but they never funded the channel. Tournament can't start with unfunded players.

**Mitigation:** TC tracks `channelFunded: true/false` per player. At cutoffBlock, TM checks all registered players have funded channels. Unfunded players are removed. If remaining players < required, cancel tournament.

### Issue 6: Score Cell Spam / Fake Scores
Any agent can write a score cell with a fake tournament ID. Type script alone doesn't prevent this — anyone can create a cell with any type script.

**Mitigation:** TM validates score cells by checking:
- Player address matches a registered player on TC
- Tournament ID matches
- Score cell created after endBlock (not during or before game)
- Agent code hash matches (if stored in score cell)

The type script can enforce the block timing constraint (using `since` field).

### Issue 7: Time Between Cutoff and Start Must Account For Channel Opens
Block timeline currently shows:
```
N+50:     entryCutoffBlock
N+50..70: Fiber channels opening
N+70:     startBlock
```
20-block gap (~3 min) might be tight if channels need 2 L1 txs each. Should be 30-50 blocks (~5-8 min).

### Issue 8: TC Data Size Grows With Players
Each player entry adds ~150 bytes to TC data. 10 players = 1.5KB extra. TC needs capacity to accommodate max players from creation.

**Mitigation:** Creator's setup fee must pre-fund TC capacity for worst case (all slots filled). Calculate: base TC data + (playerCount × per_player_bytes). This goes into the invoice breakdown.

---

## Resolved Open Questions

1. **Fiber channel open time:** ~20-30s (2 L1 txs: intent consume + channel funding). Parallel for all PAs. Need 30-50 block gap between cutoff and start.
2. **Routing:** Direct channels only for now. TM needs pre-funded Fiber float to pay winners. Recoups from closing loser channels.
3. **Channel capacity:** Entry fee = minimum. Fiber may have its own minimum (check Fiber docs). Agent float handles the rest.
4. **Force-close timeout:** Fiber default TBD — check Fiber source. Affects dispute window.
5. **Agent hash scope:** Hash tournament-manager.js + ram-engine.js + game definition JSON. Excludes UI/config. Deterministic inputs to the scoring function.

---

## Phase 3: FiberQuest Appchain (North Star)

Once v2 is battle-tested on testnet, the path to mainnet is an Axon-based L2 appchain where consensus itself enforces tournament rules. Everything we build trust workarounds for on L1 becomes a consensus guarantee.

### Consensus-Level Tournament Primitives
- **Tuned block time** (2-3s) for tighter start/end sync
- **Tournament as first-class state machine** — validators enforce state transitions natively (OPEN→ACTIVE→SETTLING→COMPLETE)
- **Score submission as consensus action** — validators reject scores before endBlock or from unregistered agents. No type scripts needed
- **Agent attestation at tx acceptance** — consensus rejects transactions from unattested code hashes

### Native Channel Enhancements
- **Tournament-scoped channels** — auto-lock funds to tournament, auto-settle on winner determination
- **Conditional channels** — "transfer balance to X if tournament Y resolves with winner Z", enforced by L2 consensus
- **Instant settlement** — no force-close timeouts, validators have full tournament context

### What the Appchain Eliminates
- Agent trust assumptions → consensus enforces
- Payout routing complexity → consensus-level auto-settlement
- Timing ambiguity → L2 controls block time
- Score cell spam → consensus rejects invalid submissions
- Voluntary send model → automatic payout

### Roadmap
1. **v2 on testnet** — prove the design, iron out edge cases
2. **v2 on mainnet** — real money, real stakes, real users
3. **Axon L2 appchain** — consensus-native tournament protocol
4. **L1 as settlement/bridge** — CKB mainnet anchors the appchain

---

## Still Open

1. **Minimum Fiber channel size** — need to check Fiber source for `min_channel_capacity`
2. **Fiber force-close timeout** — need to check Fiber source for default `to_self_delay`
3. **TM liquidity requirement** — how much Fiber float does TM need? Proportional to max concurrent tournaments × max payout
4. **Intent cell type script** — write custom, use always-success, or use existing pattern?
5. **Score cell timing enforcement** — can `since` field enforce "only after endBlock"?
