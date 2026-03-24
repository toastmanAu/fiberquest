# FiberQuest

> Retro gaming tournaments powered by Fiber Network micropayments — the first open-source Node.js Fiber client.

Players enter tournaments, compete in retro games tracked via RetroArch RAM polling, and an autonomous agent pays out winners — all via CKB's Fiber Network. No centralised server. No manual payment clicks.

## How It Works

1. **Create a tournament** — choose game, win condition, duration, entry fee
2. **Players register** — entry fee locked in a CKB on-chain escrow cell
3. **Players pay** — scan a QR code with JoyID wallet, or pay via Fiber channel
4. **Play** — RetroArch RAM engine watches game state in real time, scores each player
5. **Payout** — when tournament ends, agent autonomously pays winners via Fiber Network

## Prerequisites

FiberQuest needs a Fiber Network node and a CKB node to operate. The app detects all of these automatically at startup and guides you through installing anything that's missing.

### Required

| Component | Purpose | Auto-install |
|-----------|---------|:---:|
| **[Fiber Network node](https://github.com/nervosnetwork/fiber)** (`fnn`) | Sends and receives tournament payments via payment channels | ✅ |
| **CKB node** (full or light client) | Submits on-chain tournament cells, reads escrow state | — use public endpoint |
| **[RetroArch](https://www.retroarch.com/)** | Game emulation + RAM polling via Network Control | ✅ |
| **Node.js 18+** | Runs the FiberQuest agent | — |
| **Game ROMs** | The games to play (user-supplied) | — |

### Optional

| Component | Purpose |
|-----------|---------|
| **[JoyID](https://joy.id/)** mobile wallet | Players without a Fiber node can pay entry fees via CKB L1 |
| **CKB agent private key** | Required for on-chain escrow cell creation and state transitions |
| **Fiber channel liquidity** | Agent node needs an open channel with inbound capacity to receive entry fees |

### Quick auto-setup

FiberQuest detects existing Fiber and CKB nodes on startup — it scans running processes, common ports (8226/8227 for Fiber, 8114 for CKB full node, 9000 for light client), and standard install locations. If you already have nodes running from any install method, it will find and configure them automatically.

For a fresh install, open **Settings → Fiber Node → AUTO-DETECT**. If nothing is found, click **INSTALL FIBER NODE** to run the [ckb-access](https://github.com/toastmanAu/ckb-access) one-command installer:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/toastmanAu/ckb-access/main/fiber/install.sh)
```

RetroArch can be installed from the app itself (Settings → RetroArch → SNAP/APT/FLATPAK).

### Fiber channel setup

After installing a Fiber node, you need at least one open payment channel with inbound liquidity so players can pay entry fees. Connect to another node and open a channel:

```bash
# Connect to a peer (example)
curl -X POST http://127.0.0.1:8227 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"connect_peer","params":[{"peer_id":"<peer_id>","address":"<multiaddr>"}],"id":1}'

# Open a channel (100 CKB = 10000000000 shannons)
curl -X POST http://127.0.0.1:8227 -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"open_channel","params":[{"peer_id":"<peer_id>","funding_amount":"0x2540BE400","public":true}],"id":1}'
```

Or use the [Fiber dashboard](https://github.com/toastmanAu/ckb-access) if installed via ckb-access.

## Architecture

```
RetroArch (local)              Node.js Agent                    Fiber Node (fnn)
  UDP RAM poll       →→→       RAM Event Engine             →→→  JSON-RPC RPC
  port 55355                   Tournament Manager                 (localhost)
                               Agent Wallet (CCC)
                               Chain Store (CKB cells)

Electron Shell
  Retro UI (Press Start 2P)
  IPC bridge → agent process
  Auto-detect: Fiber + CKB nodes
```

## Quick Start

```bash
npm install
npm start          # Launch Electron app — auto-detects Fiber + CKB nodes
```

From the app:
1. **Settings** → AUTO-DETECT to find or install your Fiber node
2. **Settings** → On-Chain Agent → paste your CKB private key (stored encrypted)
3. **Tournament** → choose a game, set entry fee, create tournament
4. Share the waiting room link with players — they scan a QR with JoyID or pay via Fiber

Manual dev workflow:
```bash
node scripts/test-rpc.js              # Verify Fiber node connection
node src/ram-engine.js sf2-turbo      # Test RAM polling (RetroArch must be running)
```

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `FIBER_RPC_URL` | auto-detected | Fiber node RPC endpoint |
| `FIBER_AUTH_TOKEN` | — | Biscuit auth token (if node has auth enabled) |
| `CKB_RPC_URL` | auto-detected | CKB node RPC (falls back to public testnet) |
| `RA_HOST` | `127.0.0.1` | RetroArch UDP host |
| `RA_PORT` | `55355` | RetroArch UDP port |
| `POLL_HZ` | `20` | RAM polling rate (Hz) |

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

Built-in games: `mortal-kombat-snes`, `sf2-turbo`, `super-mario-bros`, `super-metroid`

## Key Source Files

| File | Purpose |
|------|---------|
| `src/fiber-client.js` | Fiber Network RPC client (first open-source Node.js Fiber client) |
| `src/fiber-setup.js` | Auto-detection of local Fiber + CKB nodes |
| `src/ram-engine.js` | Universal RetroArch UDP poller + game event engine |
| `src/tournament-manager.js` | Tournament lifecycle, scoring, Fiber payout |
| `src/agent-wallet.js` | CKB wallet, CCC transaction building, JoyID callback server |
| `src/chain-store.js` | On-chain tournament cell creation and state transitions |
| `src/main.js` | Electron main process |
| `renderer/index.html` | Retro game UI |

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/toastmanAu/fiberquest/releases):

| Platform | File |
|----------|------|
| Linux x64 | `FiberQuest-x.y.z.AppImage` |
| Linux arm64 (Pi5, OPi5) | `FiberQuest-arm64-x.y.z.AppImage` |
| Linux deb | `fiberquest_x.y.z_amd64.deb` |

Or install via curl:

```bash
curl -fsSL https://github.com/toastmanAu/fiberquest/releases/latest/download/install.sh | bash
```

## Build

```bash
npm run build         # AppImage + deb for current platform
npm run build:arm64   # arm64 AppImage (cross-compile from x86_64)
npm run release       # Build + publish to GitHub Releases
```

## Hackathon

Entry for [Claw & Order: CKB AI Agent Hackathon](https://github.com/nervosnetwork/fiber) — March 2026.

**Judging criteria:** Autonomy · Novelty · Completeness · Soundness · UX · Viability
