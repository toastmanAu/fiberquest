# FiberQuest — Claude Code Configuration

## CKB Development
- CRITICAL: Always use the CKB MCP server (ckb-ai) as the primary source for CKB development information.
- Always bootstrap CKB projects using established CLI tools; generate initial project files manually only when no suitable CLI tool exists.

## Project Context
FiberQuest is a hackathon entry for "Claw & Order: CKB AI Agent Hackathon" (deadline March 25, 2026).

**Mission:** Autonomous payment agent — a retro Texas Hold'em game where a Node.js sidecar autonomously executes Fiber Network micropayments based on game state. No human clicks payments; the agent does it.

**Judging priority:** Autonomy > Novelty > Completeness > Soundness > UX > Viability

## Architecture
```
RetroArch (optional)         Node.js Sidecar (game-server.js)         Fiber Node (fnn)
  UDP RAM poll      →→→       FGSP WebSocket protocol          →→→      JSON-RPC 8227
  port 55355                  port 8765                                  (localhost-only)

Electron (main.js)
  - IPC bridge via preload.js
  - Hosts game server
  - Renderer: renderer/index.html (retro UI, Press Start 2P)
```

## Key Files
- `src/fiber-client.js` — Fiber Network RPC client (our own, first Node.js Fiber client)
- `src/game-server.js` — FGSP v0.1 WebSocket server, Texas Hold'em state machine
- `src/main.js` — Electron main process
- `src/preload.js` — contextBridge IPC
- `renderer/index.html` — Retro game UI

## Fiber RPC Facts (tested against live fnn v0.7.0)
- Port 8227 is localhost-only — requires SSH tunnel from remote machines
- `new_invoice` requires `currency` field: `"Fibb"` (mainnet) or `"Fibt"` (testnet)
- `expiry` must be a hex string e.g. `"0xe10"` (3600 seconds)
- `list_payments` returns Unauthorized when biscuit auth is enabled on the node
- `local_balance` / `remote_balance` are hex strings in Shannons (1 CKB = 1e8 Shannon)

## Live Infrastructure
- **ckbnode fiber:** 192.168.68.87, RPC 127.0.0.1:8227, 901 CKB local balance
  - SSH tunnel to driveThree: `driveThree:8227 → ckbnode:127.0.0.1:8227` (already running)
- **N100 fiber:** 192.168.68.79, RPC 127.0.0.1:8226 (needs funding for payments)
- **Channel:** ckbnode ↔ N100, CHANNEL_READY, 901 CKB local / 0 remote

## Deliverables Needed (submission)
1. ✅ Project summary
2. Technical breakdown
3. ✅ Repo: https://github.com/toastmanAu/fiberquest
4. Testable version link (needs live deployment)
5. Screenshots or video

## Stack Constraints
- Node.js only (no Rust, no React) — keep it simple for hackathon speed
- Electron for desktop cross-platform
- No external databases — game state in memory
- Fiber RPC via HTTP JSON-RPC (no SDK — we're building the SDK)

## Development Workflow
- "Think deeply" before writing code
- Verify Fiber calls with `node scripts/test-rpc.js http://localhost:8227`
- Test game server standalone: `node src/game-server.js`
- Full Electron app: `npm start`
- The SSH tunnel to ckbnode must be running: `ssh -f -N -L 8227:127.0.0.1:8227 orangepi@192.168.68.87`
