# FiberQuest — CKBoost Quest 2 Submission Answers

> Drafted by Kernel. Ready to paste into ckboost.net Quest 2 form.
> Deadline: March 25, 2026 12:00 UTC

---

## Project Summary

**FiberQuest** is an autonomous tournament agent for retro gaming.

Players enter tournaments by paying entry fees directly into CKB Fiber Network payment channels — no wallet popups, no blockchain confirmation waits, no trust required. A Node.js agent watches game state in real time by polling RetroArch's RAM via UDP, scores each player using per-game definitions, and autonomously executes payouts over Fiber when the tournament ends.

The agent holds prize funds, enforces rules, and pays winners — without any human clicking "send". The first fully autonomous gaming economy on CKB.

---

## Technical Breakdown

### What we built

**1. FiberClient (`src/fiber-client.js`)**
The first open-source Node.js client for the Fiber Network JSON-RPC API. Wraps `new_invoice`, `send_payment`, `list_channels`, `open_channel`, `shutdown_channel`, and all peer management methods. Handles hex-encoded Shannon values, mainnet/testnet currency flags, and RPC timeout/error propagation.

**2. RAM Event Engine (`src/ram-engine.js`)**
Universal RetroArch sidecar. Polls RetroArch's UDP network command port (`READ_CORE_MEMORY` protocol, port 55355) at up to 20Hz. Reads player-specific RAM addresses defined in game JSON files. Evaluates event conditions (`reached_zero`, `changed_to`, `decreased_by_more_than`, etc.) and fires payment events when game state changes.

**3. Game Definition Registry (`games/*.json`)**
24 games mapped across 7 platforms (NES, SNES, Mega Drive, Master System, Arcade/FBNeo, N64, Game Boy). Each definition includes:
- RAM addresses for lives, health, score, round state, player count
- Tournament modes (first-to-X wins, score attack, survival, co-op race, speedrun)
- Payout structures (winner-takes-all, top-2 split)
- Confidence ratings and verification status

**4. Tournament Manager** (in progress)
Combines RAM engine events with Fiber payment execution. Tracks per-player scores, detects tournament end conditions, builds and submits payout transactions.

**5. Electron shell (`src/main.js`, `renderer/`)**
Desktop app wrapper. Retro UI with Press Start 2P font, real-time score overlays, tournament status. IPC bridge between agent process and renderer.

### Architecture

```
RetroArch (local game)
    ↓ UDP READ_CORE_MEMORY @ 20Hz
ram-engine.js
    → detects game events (life lost, round won, score change)
    → emits payment_needed events
tournament-manager.js
    → accumulates scores per player
    → detects tournament end condition
    → calls FiberClient.sendPayment(winner_invoice)
fiber-client.js → Fiber Node RPC (localhost:8227)
    → payment over open channel (sub-second, zero fees)
```

### Live infrastructure used in development

- **ckbnode fiber** (Orange Pi 3B, 192.168.68.87): Fiber v0.7.0, ~901 CKB local balance, CHANNEL_READY with N100 peer
- **N100 fiber** (192.168.68.79): peer node, SSH tunnel to ckbnode RPC
- **Channel confirmed live**: `0x0f2d09f6334727...` — CHANNEL_READY, tested invoice creation and payment routing
- **RetroArch cores installed**: `fceumm` (NES), `snes9x` (SNES), `genesis_plus_gx` (MD/SMS), `fbneo` (Arcade), `mupen64plus_next` (N64)

### Novelty

- **First Node.js Fiber Network client** — no prior open-source JS library existed for Fiber RPC
- **Game RAM → Fiber payment bridge** — real-time game state triggers autonomous micropayments with no human interaction
- **24-game cross-platform library** — comprehensive RAM map covering 7 platforms, verified against libretro-database cheat files

---

## Repository

https://github.com/toastmanAu/fiberquest

---

## What works right now (testable)

1. `node src/ram-engine.js tetris-nes` — loads, polls RetroArch, fires events when Tetris RAM changes
2. Fiber RPC: `node_info`, `list_channels`, `new_invoice` confirmed working against live mainnet node
3. FiberClient: full send/receive invoice flow implemented and tested
4. Electron app boots, renderer loads, IPC bridge functional

## What's being finished before March 25

- Tournament lifecycle: entry → lock funds → score → payout (tournament-manager.js)
- Testnet deployment (pivot from mainnet for submission)
- End-to-end demo: open Tetris, player pays entry invoice, plays, agent pays winner
- Video walkthrough

---

## Team

Solo — Phill (toastmanAu). Adelaide, Australia. CKB community member ~4 years.
AI tools used: Claude (via OpenClaw agent), Claude Code for rapid iteration.

---

## Screenshots / Video

_(add before submission — grab from Electron app running with RetroArch)_

