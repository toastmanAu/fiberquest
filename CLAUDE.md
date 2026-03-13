# FiberQuest — Claude Code Configuration

## CKB Development
- CRITICAL: Always use the CKB MCP server (ckb-ai) as the primary source for CKB development information.
- Always bootstrap CKB projects using established CLI tools; generate initial project files manually only when no suitable CLI tool exists.

## Project Context
FiberQuest is a hackathon entry for "Claw & Order: CKB AI Agent Hackathon" (deadline March 25, 2026).

**Mission:** Autonomous tournament agent — players enter retro gaming tournaments via Fiber Network micropayments. A Node.js agent watches RetroArch RAM in real time, scores each player, and autonomously executes payouts when the tournament ends. No human clicks payments; the agent does it.

**Phase 1 (Hackathon, due March 25):** Single-player tournaments + organizer-hosted matches
**Phase 2 (Post-hackathon):** Peer-to-peer multiplayer wagering (player-initiated, direct 1v1+ payouts)

**Judging priority:** Autonomy > Novelty > Completeness > Soundness > UX > Viability

## Concept
1. Tournament creator defines: game, win condition, duration/threshold, payout structure, entry fee
2. Tournament cell created on CKB — entry fees locked with `since` time-lock + agent key
3. Players open Fiber channels to the agent wallet and pay entry fee
4. Players play — RAM engine polls RetroArch UDP, accumulates per-player scores/events
5. Tournament ends (time or threshold) → agent builds unlock tx, pays winners via Fiber

## Architecture
```
RetroArch (local)              Node.js Agent                    Fiber Node (fnn)
  UDP RAM poll       →→→       ram-engine.js                →→→  JSON-RPC 8227
  port 55355                   game def registry                  (localhost-only)
                               tournament-manager.js
                               agent-wallet.js (CCC)

Electron (main.js)
  - IPC bridge via preload.js
  - Hosts agent process
  - Renderer: renderer/index.html (retro UI, Press Start 2P)
```

## Key Files
- `src/fiber-client.js` — Fiber Network RPC client (first open-source Node.js Fiber client)
- `src/ram-engine.js` — Universal RetroArch UDP poller + game event engine
- `src/tournament-manager.js` — Tournament cell creation, scoring, payout logic (TODO)
- `src/agent-wallet.js` — CKB wallet, cell building, CCC integration (TODO)
- `src/main.js` — Electron main process
- `src/preload.js` — contextBridge IPC
- `renderer/index.html` — Retro game UI
- `games/*.json` — Game definitions (RAM addresses + events + tournament modes)

## Game Definition Schema
Each `games/<id>.json` defines:
- `addresses` — RetroArch RAM addresses to watch
- `events` — triggers + Fiber payment directions
- `tournament.metrics` — what to accumulate (score, levels, rounds, etc.)
- `tournament.win_conditions` — time_limit / score_threshold / first_to_wins
- `tournament.payout_structures` — winner_takes_all / top2_split / top3_split
- `tournament.entry` — fixed or variable stake

## Fiber RPC Facts (tested against live fnn v0.7.0)
- Port 8227 is localhost-only — requires SSH tunnel from remote machines
- `new_invoice` requires `currency` field: `"Fibb"` (mainnet) or `"Fibt"` (testnet)
- `expiry` must be a hex string e.g. `"0xe10"` (3600 seconds)
- `list_payments` returns Unauthorized when biscuit auth is enabled on the node
- `local_balance` / `remote_balance` are hex strings in Shannons (1 CKB = 1e8 Shannon)

## Live Infrastructure
- **ckbnode fiber:** 192.168.68.87, RPC 127.0.0.1:8227, ~900 CKB local balance
  - SSH tunnel from Pi5: `localhost:18227 → ckbnode:127.0.0.1:8227`
- **N100 fiber:** 192.168.68.79, RPC 127.0.0.1:8226 (needs funding)
- **Channel:** ckbnode ↔ N100, CHANNEL_READY
- **Network:** mainnet (testnet pivot when code is solid)

## Deliverables Needed (submission)
1. ✅ Project summary
2. Technical breakdown (needs rewrite)
3. ✅ Repo: https://github.com/toastmanAu/fiberquest
4. Testable version link (needs live deployment)
5. Screenshots or video

## Stack Constraints
- Node.js only (no Rust, no React) — keep it simple for hackathon speed
- Electron for desktop cross-platform
- CCC (@ckb-ccc/core) for CKB transaction building
- No external databases — tournament state in memory + on-chain cell
- Fiber RPC via HTTP JSON-RPC

## Development Workflow
- Verify Fiber calls: `node scripts/test-rpc.js http://localhost:18227`
- Test RAM engine: `node src/ram-engine.js sf2-turbo`
- Full Electron app: `npm start`
- SSH tunnel to ckbnode: `ssh -f -N -L 18227:127.0.0.1:8227 orangepi@192.168.68.87`
