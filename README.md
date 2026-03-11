# FiberQuest

> Retro gaming powered by Fiber Network micropayments — the first open-source Node.js Fiber client.

## Quick Start

```bash
npm install
npm run test:rpc        # Verify Fiber node connection
npm run server          # Start game server standalone
npm start               # Launch Electron app
```

## Architecture

```
fiberquest/
├── src/
│   ├── main.js          — Electron main process
│   ├── preload.js       — IPC bridge (contextBridge)
│   ├── fiber-client.js  — Fiber Network RPC client
│   └── game-server.js   — FGSP WebSocket game server
├── renderer/
│   └── index.html       — Game UI (Press Start 2P, retro aesthetic)
└── scripts/
    └── test-rpc.js      — Live RPC test + schema documenter
```

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `FIBER_RPC_URL` | `http://127.0.0.1:8227` | Fiber node RPC endpoint |
| `GAME_PORT` | `8765` | FGSP WebSocket server port |
| `RA_PORT` | `55355` | RetroArch UDP port |
| `NODE_ENV` | — | Set to `development` for DevTools |

## Build for Pi5 (arm64)

```bash
# On driveThree (x86_64)
sudo apt install qemu-user-static binfmt-support
docker run --privileged --rm tonistiigi/binfmt --install arm64

npm run build:arm64
# Output: dist/FiberQuest-0.1.0-arm64.AppImage
```

## Fiber RPC Test

```bash
# Against local node
node scripts/test-rpc.js

# Against N100 tunnel
node scripts/test-rpc.js http://localhost:8237

# Against ckbnode via SSH tunnel
ssh -L 8227:127.0.0.1:8227 ckbnode
node scripts/test-rpc.js http://localhost:8227
```

## FGSP Protocol

```
Client → Server:
  FGSP_CONNECT        { name, fiberNodeId }
  FGSP_PLAYER_ACTION  { action: FOLD|CHECK|CALL|RAISE|ALL_IN, amount }
  FGSP_PAYMENT_CONFIRM { paymentHash, amount_ckb }

Server → Client:
  FGSP_WELCOME        { playerId, name, state, buyInCkb }
  FGSP_GAME_STATE_UPDATE { phase, players, pot, communityCards, currentPlayer, ... }
  FGSP_PAYMENT_REQUEST { type, amount_ckb, invoice, description, expires_in }
  FGSP_ERROR          { message }
```
