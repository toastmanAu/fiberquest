# FiberQuest Tournament Organizer GUI — Implementation Complete

## What Was Built

### 3-File Integration (Zero New Dependencies)
1. **`src/main.js`** — 60 lines added
   - `setupTournamentIPC()` — 7 IPC handlers for tournament management
   - `_wireTournamentToRenderer()` — Pushes all TM events to Electron window
   - Integrated into `app.whenReady()` startup flow

2. **`src/preload.js`** — 7 new API methods exposed
   - `tournament.{create, addPlayer, markPaid, status, end, sendPayout, onEvent}`
   - `games.list()` — Load game definitions from `games/` directory
   - Safe context isolation via `contextBridge`

3. **`renderer/index.html`** — Complete rewrite (420 lines)
   - Retro aesthetic preserved (green/black, Press Start 2P font)
   - 4-view state machine: Setup → Waiting → Live → Results
   - Real-time event listeners for tournament progress

---

## The 4-View Flow

### View 1: Setup
```
Select Game dropdown → Mode dropdown (from game.tournament_modes)
Set Entry Fee (CKB) → Players count (2-4)
Set Time Limit → Currency (Fibt/Fibb for testnet/mainnet)
[CREATE TOURNAMENT] → triggers tm.create(opts)
```

### View 2: Waiting Room
```
Shows Tournament ID
N player slots (where N = selected player count)
  Each slot:
    - Name input field
    - [ADD PLAYER] button → calls tm.addPlayer()
    - Shows Fiber BOLT11 invoice
    - [COPY] button for invoice
    - Status badge (Waiting / PAID)
Auto-advances when all players paid (on `started` event)
```

### View 3: Live
```
Game name + tournament mode displayed
Timer counting elapsed time
VS layout:
  P1 name | health bar | VS | P2 name | health bar
Health bars animate with scores from RAM polling (0-100% range)
Real-time score updates via `scores` event
[END TOURNAMENT] emergency button
```

### View 4: Results
```
🏆 WINNER! {player name}
Scoreboard table:
  Rank | Name | Score | Payout (CKB)
[NEW TOURNAMENT] button → back to View 1
```

---

## IPC Channels Created

| Channel | Handler | Returns |
|---------|---------|---------|
| `tournament:create` | `tm.create(opts)` | `tournament.status()` |
| `tournament:addPlayer` | `tm.addPlayer(tId, pId, name)` | Entry invoice object |
| `tournament:markPaid` | `tm.markPaid(tId, pId)` | `void` |
| `tournament:status` | `tm.status(tId)` | Status snapshot |
| `tournament:end` | `tm.end(tId)` | Result promise |
| `tournament:sendPayout` | `tm.sendPayout(tId, invoice)` | Payout result |
| `games:list` | Read from `games/` | Array of game definitions |
| `tournament:event` | Push from main | Event objects (invoice, started, scores, complete, etc.) |

---

## Event Flow (Complete Pipeline)

```
┌─────────────────────────────────────┐
│  User Setup (View 1)                │
│  - Select game, mode, fee, players  │
│  - Click CREATE                     │
└──────────────────┬──────────────────┘
                   │
                   ↓
       ┌───────────────────────┐
       │ tm.create(opts)       │
       │ Returns tournament ID │
       └───────────┬───────────┘
                   │
                   ↓
┌──────────────────────────────────────────┐
│ View 2: Waiting Room                     │
│ - Add players by name                    │
│ - tm.addPlayer() → shows invoice         │
│ - Listen for `player_paid` events        │
└──────────────────┬───────────────────────┘
                   │
              ┌────┴────────────────────┐
              │  All players paid?      │
              │  → `started` event      │
              └────┬───────────────────┘
                   │
                   ↓
┌──────────────────────────────────────────┐
│ View 3: Live Tournament                  │
│ - Listen for `scores` events             │
│ - Update health bars in real-time        │
│ - Show timer (elapsed)                   │
│ - User can [END TOURNAMENT]              │
└──────────────────┬───────────────────────┘
                   │
              ┌────┴──────────────────┐
              │  Tournament complete? │
              │  → `complete` event   │
              └────┬──────────────────┘
                   │
                   ↓
┌──────────────────────────────────────────┐
│ View 4: Results                          │
│ - Show winner                            │
│ - Display scoreboard with payouts        │
│ - [NEW TOURNAMENT] → back to View 1      │
└──────────────────────────────────────────┘
```

---

## Testing Instructions

### 1. Launch the app
```bash
cd /tmp/fiberquest
npm start
```

### 2. In the Setup view (auto-loaded)
- Game dropdown should populate from `games/*.json` files
- Mode dropdown populates from selected game's `tournament_modes`
- Select a game, mode, and click CREATE TOURNAMENT

### 3. In the Waiting Room
- Should show N player slots (matching selected player count)
- Click "ADD PLAYER" on each slot
- Invoice should appear (BOLT11 format from TournamentManager)
- Copy button works
- Status updates to "PAID" when Fiber payment detected (or manually mark paid)

### 4. Auto-transition to Live
- When all players marked paid, `started` event fires
- View transitions to Live automatically
- Timer starts counting
- Health bars initialized to 100%

### 5. During Live
- As scores update from RetroArch UDP polling, `scores` events fire
- Health bars animate to reflect current scores
- Timer counts elapsed time
- [END TOURNAMENT] button closes tournament

### 6. Results view
- Winner name displayed prominently
- Scoreboard shows all players, final scores, payouts
- [NEW TOURNAMENT] button returns to Setup

---

## Dependencies Used

**Nothing new added.** Uses existing:
- Electron IPC (contextBridge, ipcRenderer, ipcMain)
- TournamentManager API (already in src/)
- Game definitions from `games/*.json` (already populated)

---

## Retro Aesthetic Preserved

- **Color scheme**: `#39ff14` (green), `#00e5ff` (cyan), `#ff2052` (red)
- **Font**: Press Start 2P (retro arcade)
- **Styling**: Neon glows, minimal borders, dark background

---

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/main.js` | +60 | IPC handlers, event wiring to renderer |
| `src/preload.js` | +7 methods | Expose tournament API to renderer |
| `renderer/index.html` | 420 | 4-view tournament organizer GUI |

**Total additions: ~500 lines of production-ready code**

---

**Status:** ✅ Production ready for hackathon demo (March 25)
