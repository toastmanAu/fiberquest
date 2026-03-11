# FiberQuest — CKBoost Quest 2 Form Answers

> Ready to paste. Updated to reflect current build state (2026-03-12).

---

## 1. System Design
*Share important user, agent, UI and backend flows*

### Overview

FiberQuest is an autonomous tournament referee agent for retro gaming. Players enter tournaments by paying entry fees over Fiber Network payment channels. An AI agent watches live game RAM, scores each player in real time, and fires autonomous Fiber payouts to the winner — no wallet popups, no confirmations, no trust required.

### Core Flows

**Player Entry Flow:**
1. Player opens FiberQuest (Electron desktop app)
2. Selects game + tournament mode (Score Attack, Survival, Race, etc.)
3. Agent generates a Fiber Network invoice for the entry fee
4. Player scans the invoice QR code with their Fiber-connected wallet and pays
5. Agent detects the incoming payment via `list_payments` polling (auto-start when all players paid)
6. Player also submits a *payout invoice* (generated on their own Fiber node) — this is what the agent will pay them if they win

**Tournament Active Flow:**
1. Agent starts a RAM polling loop — reads RetroArch's memory over UDP at 20Hz using `READ_CORE_MEMORY` protocol
2. RAM values are decoded per game (BCD scores, uint8 lives, uint16 health) using per-game address definitions
3. Scores update in real time in the Electron UI overlay
4. Win conditions checked every poll: time limit expired, first player to reach target value, all lives gone, etc.

**Payout Flow:**
1. Tournament ends — agent determines winner from final score board
2. If winner pre-registered a payout invoice: agent calls `send_payment(payoutInvoice)` immediately and autonomously
3. Payment routes over the existing Fiber channel — sub-second, zero on-chain fees
4. UI shows winner + payment hash confirmation
5. If no payout invoice registered: agent emits event, host can submit invoice manually and trigger payout

**Backend (Node.js sidecar):**
- `ram-engine.js` — UDP poller, game-specific RAM decode, event emitter
- `tournament-manager.js` — lifecycle state machine (CREATED → WAITING → ACTIVE → SCORING → PAYING → COMPLETE), score tracking, payout logic
- `fiber-client.js` — Fiber RPC wrapper (invoices, payments, channels, peers)
- `game-server.js` — WebSocket server, coordinates multi-player sessions

**UI (Electron renderer):**
- Press Start 2P retro aesthetic
- Real-time score overlay during match
- QR code display for entry + payout invoices
- Tournament status, player paid indicators, winner announcement

---

## 2. Setup Environment
*List your local setup environment and AI/agent stack*

### Hardware

| Machine | Role | Specs |
|---------|------|-------|
| Orange Pi 5 (arm64) | Agent host — runs FiberQuest sidecar, OpenClaw AI | Ubuntu 22.04, 8GB RAM |
| Orange Pi 3B (arm64) | Fiber Network node (ckbnode) | OrangePi OS 5.10 BSP, 4GB RAM |
| NucBox K8 Plus (x86_64, Ryzen 7 8845HS) | Second Fiber node + dev inference | 32GB RAM, Radeon 780M |
| driveThree (x86_64, i7-14700K + RTX 3060 Ti) | Game host — runs RetroArch | Ubuntu 22.04, 64GB RAM |
| RG35XX H handheld | Alternative game host (KNULLI/RetroArch) | ARM, WiFi |
| Retroid Pocket 4 Pro | Alternative game host (Android + RetroArch) | Snapdragon, WiFi |

### Software Stack

**Game layer:**
- RetroArch 1.21.0 — network commands enabled (UDP port 55355)
- Cores: fceumm (NES), snes9x (SNES), genesis_plus_gx (MD/SMS), fbneo (Arcade), mupen64plus_next (N64)
- 24 games across 7 platforms — all ROMs locally present

**Agent layer:**
- Node.js 25 (arm64)
- Electron 33 (desktop wrapper)
- Custom `fiber-client.js` (first open-source Node.js Fiber RPC client)
- RAM engine polling at 20Hz over RetroArch UDP protocol

**Infrastructure:**
- Fiber Network v0.7.0 on two nodes (ckbnode + NucBox)
- One CHANNEL_READY mainnet channel — ~901 CKB local balance
- SSH tunnel: N100:8237 → ckbnode:127.0.0.1:8227 (persisted as systemd service)
- CKB full node v0.204.0 (Orange Pi 3B, ~18.8M blocks)

**AI/Agent stack:**
- OpenClaw (personal AI agent framework) running on Pi 5
- Claude Sonnet (via CKBDev shared API) — primary model
- Agent is "Kernel" — persistent identity, does autonomous dev work, monitors infrastructure

---

## 3. Tooling
*What CKB-related on-chain elements (or Fiber/Perun), tooling, or infrastructure does your application use?*

### Fiber Network (primary)

**Payment channels:**
- One mainnet channel between two self-hosted Fiber nodes (ckbnode ↔ NucBox)
- Channel state: CHANNEL_READY, ~901 CKB local balance
- All tournament entry fees and payouts route through this channel

**Fiber RPC methods used:**
- `new_invoice` — generate entry fee and payout invoices (BOLT11-compatible)
- `send_payment` — autonomous winner payout
- `list_payments` — poll for incoming entry fee confirmations
- `local_node_info` — node health + version checks
- `list_channels` — channel balance monitoring
- `open_channel` / `shutdown_channel` — channel lifecycle (implemented, ready for multi-node)
- `add_tlc` / `remove_tlc` — low-level payment primitives (implemented in FiberClient)

**Custom tooling built on top of Fiber:**
- `fiber-client.js` — first open-source Node.js Fiber RPC client. Handles hex Shannon encoding/decoding, currency flags (Fibb/Fibt), invoice parsing, timeout management. MIT licensed.

### CKB Chain

- CKB full node v0.204.0 running locally (required for Fiber node operation)
- On-chain channel open/close transactions use standard CKB lock scripts
- Fiber node manages the CKB layer — FiberQuest interacts only at the payment channel layer

### Related tools

- `ckb-access` / `fiber-installer` — our own one-command Fiber node installer (also shipped during hackathon, available at github.com/toastmanAu/ckb-access). Judges can use this to spin up a Fiber node in minutes.
- CKB light client v0.5.5-rc1 — verified on 3 aarch64 boards during development (Pi 5, Zero 3, OPi 3B). Verification report published.

---

## 4. Current Functionality
*Explain in detail the current functionality*

### What works right now (as of 2026-03-12, Day 2 of hackathon)

**Fiber integration — fully live:**
- FiberClient connects to running Fiber v0.7.0 mainnet node
- Invoice generation: creates real BOLT11-format invoices (e.g. `fibb1000000001pms3ac...`) with correct Shannon amounts and hex-encoded expiry
- Payment detection: polls `list_payments` to detect when entry fees arrive
- Autonomous payout: when a player pre-registers their payout invoice, the agent calls `send_payment` with no human interaction
- Channel monitoring: reads local/remote balance, connection status

**RAM engine — fully operational:**
- Polls RetroArch's RAM over UDP `READ_CORE_MEMORY` at 20Hz
- Handles both aarch64 (Pi, handheld) and x86_64 (driveThree) RetroArch instances
- Decodes: BCD multi-byte scores (NES Tetris 6-digit score), uint8/uint16 values, big-endian Mega Drive values
- 24 game definitions loaded and parseable:
  - Confirmed high-confidence: Tetris (NES), Super Mario Bros (NES), Sonic 1 (SMS), Sonic 2 (MD), Streets of Rage 2 (MD), Mario Kart 64, Super Mario Kart (SNES), GoldenEye 007 (N64), Bubble Bobble (NES), and more
  - Supported platforms: NES, SNES, Mega Drive, Master System, Arcade (FBNeo), N64

**Tournament manager — core loop working:**
- Full state machine: CREATED → WAITING_PLAYERS → ACTIVE → SCORING → PAYING → COMPLETE
- Player registration with entry invoice generation
- Payment polling — auto-starts tournament when all players have paid
- Score tracking — updates per-player scores from RAM every poll cycle
- Win conditions: time limit, first-to-target-value, manual end
- Payout structures: winner-takes-all, top-2 split (70/30)
- Autonomous payout fires immediately on win if player pre-registered payout invoice
- Graceful fallback: emits `payout_needed` event for manual payout if no invoice registered

**Electron app:**
- Boots and loads renderer
- IPC bridge between agent and UI working
- Press Start 2P retro styling

**Tested end-to-end in demo mode:**
```
node src/tournament-manager.js tetris-nes highest_score
→ Connects to live Fiber node (901 CKB)
→ Generates real mainnet invoice
→ Starts RAM engine, polls Tetris at 20Hz
→ Runs 1-minute tournament
→ Determines winner from score
→ Fires payout (autonomous if PAYOUT_INVOICE set)
```

**Repository:** https://github.com/toastmanAu/fiberquest

---

## 5. Future Functionality
*Explain future functionality that could be explored beyond the hackathon*

### Near-term (could ship in weeks)

**Multi-device tournaments:**
Each player runs RetroArch on their own device (laptop, handheld, phone via Android RetroArch). The agent polls multiple RetroArch instances simultaneously — one per player — over the network. True head-to-head competition where players are physically separate but provably scored the same game simultaneously.

**Handheld-native experience:**
KNULLI/JELOS handhelds (e.g. Anbernic RG35XX H) run RetroArch with network commands already enabled. A player turns on their handheld, loads a game, and the tournament agent connects to it automatically over WiFi. Zero setup for the player — they just play.

**Streaming payout triggers:**
Instead of end-of-match payouts, stream micro-payments for in-game milestones: every kill in GoldenEye, every ring collected in Sonic, every line cleared in Tetris. True pay-per-action streaming payments that would be impossible on any on-chain system.

### Medium-term

**Permissionless tournament hosting:**
Anyone with a Fiber node and FiberQuest installed can host tournaments. The agent opens channels with players automatically. Host sets game, rules, entry fee, and payout split — everything else is autonomous. No platform, no server, no trust.

**Cross-game leagues:**
Season-long competitions across multiple games. Players accumulate points across different games (Tetris score + GoldenEye kills + Mario Kart placements). Agent tracks cumulative standings and pays out at season end.

**Spectator betting:**
Third parties can fund a side-pool and bet on match outcomes. Smart contracts on CKB layer hold spectator bets; Fiber handles the instant payouts when the agent reports results. On-chain finality for dispute resolution, off-chain speed for everything else.

**ESP32-P4 embedded agent:**
The WyVault ESP32-P4 board (ordered) has enough processing power to run a CKB light client + Fiber payment signing concurrently with game emulation. A fully self-contained tournament terminal — the game, the agent, and the wallet all in one physical device. No laptop required.

### Long-term

**Protocol standardization:**
Open-source the RAM event format and Fiber payment bridge as a standard. Any game developer can add a `fiberquest.json` to their RetroArch core and instantly enable tournament monetization. Similar to how libretro standardized core development.

**Mobile companion app:**
Players generate payout invoices, scan entry QR codes, and track live tournament scores from their phone. Fiber payments happen at the same time as they're watching the game — the gap between "I won" and "money received" collapses to zero.

**AI referee extensions:**
Computer vision scoring for games without accessible RAM (e.g. original hardware connected via capture card). The agent watches the video feed instead of memory addresses — same tournament logic, different input source. Enables tournaments on hardware that can't run RetroArch at all.
