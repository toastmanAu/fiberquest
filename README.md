# FiberQuest

> Retro gaming tournaments powered by Fiber Network micropayments — the first open-source Node.js Fiber client.

Players enter tournaments, compete in retro games tracked via RetroArch RAM polling, and an autonomous agent pays out winners — all via CKB's Fiber Network. No centralised server. No manual payment clicks.

## How It Works

1. **Create a tournament** — choose game, win condition, duration, entry fee
2. **Entry fee locked** — in a CKB cell with a `since` time-lock + agent key
3. **Players connect** — open a Fiber channel to the agent wallet, pay entry via micropayment
4. **Play** — RetroArch RAM engine watches game state in real time, scores each player
5. **Payout** — when tournament ends, agent autonomously unlocks the cell and pays winners via Fiber

## Architecture

```
RetroArch (local)              Node.js Agent                    Fiber Node (fnn)
  UDP RAM poll       →→→       RAM Event Engine             →→→  JSON-RPC RPC
  port 55355                   Tournament Manager                 (localhost)
                               Agent Wallet (CCC)

Electron Shell
  Retro UI (Press Start 2P)
  IPC bridge → agent process
```

## Game Definitions

Games are defined in `games/*.json` — drop a new JSON to add any RetroArch game:

```json
{
  "id": "super-mario-bros",
  "addresses": { "score_hi": { "addr": "0x07DD" }, ... },
  "events": [ { "id": "level_cleared", "trigger": {...}, "payment": {...} } ],
  "tournament": {
    "win_conditions": ["time_limit", "score_threshold"],
    "payout_structures": ["winner_takes_all", "top2_split", "top3_split"],
    "entry": { "modes": ["fixed", "variable"] }
  }
}
```

Built-in games: `sf2-turbo`, `super-mario-bros`

## Quick Start

```bash
npm install
node scripts/test-rpc.js      # Verify Fiber node connection
node src/ram-engine.js sf2-turbo  # Test RAM polling (RetroArch must be running)
npm start                     # Launch Electron app
```

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `FIBER_RPC_URL` | `http://127.0.0.1:8227` | Fiber node RPC endpoint |
| `RA_HOST` | `127.0.0.1` | RetroArch UDP host |
| `RA_PORT` | `55355` | RetroArch UDP port |
| `POLL_HZ` | `20` | RAM polling rate (Hz) |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/fiber-client.js` | Fiber Network RPC client (first open-source Node.js Fiber client) |
| `src/ram-engine.js` | Universal RetroArch UDP poller + game event engine |
| `src/tournament-manager.js` | Tournament cell creation, scoring, payout *(in progress)* |
| `src/agent-wallet.js` | CKB wallet + CCC transaction building *(in progress)* |
| `src/main.js` | Electron main process |
| `renderer/index.html` | Retro game UI |

## Build for Pi5 (arm64)

```bash
# On driveThree (x86_64)
npm run build:arm64
# Output: dist/FiberQuest-arm64.AppImage
```

## Hackathon

Entry for [Claw & Order: CKB AI Agent Hackathon](https://github.com/nervosnetwork/fiber) — March 2026.

**Judging criteria:** Autonomy · Novelty · Completeness · Soundness · UX · Viability
