# FiberQuest Multiplayer Peer-to-Peer Wagering

## Phase 2 Expansion: Direct Player Wagers

### Overview
Beyond tournament organizer-hosted tournaments, enable direct peer-to-peer player wagering on multiplayer games.

**Use case:** Two players want to play Street Fighter II Turbo, wager CKB directly, play best-of-3, winner takes the pool.

---

## Architecture

### Wager Flow

```
Player A (Seller)                    Fiber Channel                    Player B (Buyer)
├─ Opens Fiber channel ─────────────────→ Agent Wallet
│  - Sets game: SF2 Turbo
│  - Sets wager: 0.5 CKB
│  - Sets terms: Best-of-3, P1 vs P2
│  - Funds channel with wager pool (1 CKB = 2x player stake)
│
├─ Sends wager invite ──────────────────→ [Agent broker]
                                          └─→ Notifies Player B via mini-app

Player B joins wager:
├─ Opens Fiber channel ─────────────────→ Agent Wallet
│  - Accepts wager: SF2 Turbo, 0.5 CKB
│  - Funds their half of pool
│  - Confirms game settings
│
├─ Play Game ──────────────────────────────→
│  - RetroArch launches with both controllers
│  - RAM engine watches both P1 & P2 memory addresses
│  - Accumulates match results (round wins, scores)
│
├─ Best-of-3 Complete
│  - Agent calculates winner (e.g., 2-1)
│  - Creates on-chain settlement cell
│  - Winner gets 1 CKB via Fiber payout
│  - Loser's channel closes with 0 balance
```

---

## Wager UI Components

### 1. Wager Setup Screen (Login + Funding)

```
┌─────────────────────────────────────┐
│  🎮 FiberQuest Direct Wager          │
├─────────────────────────────────────┤
│                                     │
│  📱 Login via JoyID / MetaMask      │
│  [Login button]                     │
│                                     │
│  Game Selection:                    │
│  [Dropdown] Street Fighter II Turbo │
│                                     │
│  Wager Amount:                      │
│  [Input] 0.5 CKB                    │
│                                     │
│  Match Terms:                       │
│  [Radio] Best of 1                  │
│  [Radio] Best of 3 ◉                │
│  [Radio] Best of 5                  │
│                                     │
│  Controller Setup:                  │
│  [P1] Player A          [P2] Player B
│  [Confirm]              [Waiting...]   │
│                                     │
│  💰 Pool: 1.0 CKB                   │
│           (Your: 0.5 | Opponent: ?) │
│                                     │
│  [🔐 Fund Fiber Channel] [Cancel]   │
└─────────────────────────────────────┘
```

### 2. Wager Lobby / Invite Code

```
┌─────────────────────────────────────┐
│  🎮 Waiting for Opponent             │
├─────────────────────────────────────┤
│                                     │
│  Game: Street Fighter II Turbo      │
│  Wager: 0.5 CKB                     │
│  Format: Best of 3                  │
│                                     │
│  Invite Code: FIBR-9K7M-2Q3X        │
│  [Copy] [Share via Telegram]        │
│                                     │
│  Waiting for opponent to fund...    │
│  [Cancel Wager]                     │
│                                     │
│  Your Channel:                      │
│  └─ Status: CHANNEL_READY           │
│  └─ Balance: 0.5 CKB                │
│  └─ ID: ckb1qzda0cr08m85hc8...      │
│                                     │
└─────────────────────────────────────┘
```

### 3. Match UI (During Play)

```
┌──────────────────────────────────────────┐
│  🎮 Street Fighter II Turbo              │
├──────────────────────────────────────────┤
│                                          │
│  [Game Screen (RetroArch)]               │
│  ██████████████████████████████████      │
│  ██████████████████████████████████      │
│  ██████████████████████████████████      │
│  ██████████████████████████████████      │
│  ██████████████████████████████████      │
│                                          │
├──────────────────────────────────────────┤
│                                          │
│  Match: 1 of 3                           │
│  P1 (A) [████ 80 HP]  vs  [██ 20 HP] (B)│
│                                          │
│  Wager: 0.5 CKB each | Pool: 1.0 CKB   │
│                                          │
└──────────────────────────────────────────┘
```

### 4. Match Result + Settlement

```
┌─────────────────────────────────────┐
│  🏆 Match 1 Complete!                │
├─────────────────────────────────────┤
│                                     │
│  Match 1: Player A WINS             │
│  Round Record: 2-1                  │
│                                     │
│  Best of 3 Score: 1-0 (A leads)     │
│                                     │
│  [Return to Lobby] [Rematch]        │
│                                     │
│  💰 Running Pool: 1.0 CKB           │
│     (Both still funded)             │
│                                     │
│  ⏳ Match 2 Starting in 3...2...1... │
│                                     │
└─────────────────────────────────────┘
```

### 5. Final Settlement (Tournament End)

```
┌─────────────────────────────────────┐
│  🎊 Best of 3 Complete!              │
├─────────────────────────────────────┤
│                                     │
│  Final Score: Player A 2 - 1 Player B
│                                     │
│  🏆 WINNER: Player A                 │
│                                     │
│  Settlement:                        │
│  ├─ Pool: 1.0 CKB                  │
│  ├─ Winner: Player A                │
│  ├─ Payout: 1.0 CKB                │
│                                     │
│  📋 Fiber Tx Hash:                  │
│  0xabcd...1234                      │
│                                     │
│  ⏳ Settling on chain...             │
│  [View Receipt]                     │
│                                     │
└─────────────────────────────────────┘
```

---

## Multiplayer Game Support

### Supported Games (Tier 1 Candidates)

| Game | Platform | Players | RAM Addresses | Notes |
|------|----------|---------|---------------|-------|
| **Street Fighter II Turbo** | CPS1 | 2 (1v1) | P1 HP, P2 HP, round counter | Straightforward score-based |
| **Super Smash Bros 64** | N64 | 2-4 | Player stocks, damage %, KO count | Chaos multiplayer |
| **Mario Kart 64** | N64 | 2-4 | Race position, lap count, finish time | Position-based ranking |
| **Monopoly** | SNES/Genesis | 2-4 | Player wealth, properties owned, position | Economic simulator |
| **Mortal Kombat 3** | Genesis | 2 (1v1) | P1 HP, P2 HP, fatality flag | Fighting game |
| **Wheel of Fortune** | SNES/NES | 2-4 | Category match, score per player | Word puzzle wagering |
| **Bomberman** | Genesis/SNES | 2-4 | Player alive flag, bomb count | Elimination game |
| **Golden Axe** | Genesis | 1-2 (co-op) | Gold count, enemy defeated, level progress | Co-op wager (shared reward) |

### Scoring Logic by Game Type

**1v1 Fighting Games (SF2, MK3):**
```
winner = player_with_higher_hp_remaining OR
         rounds_won >= 2 (best of 3) OR
         first_fatality_successful
```

**Racing Games (Mario Kart):**
```
winner = player_with_lowest_finish_time OR
         player_with_highest_lap_count
```

**Economic Games (Monopoly):**
```
winner = player_with_highest_wealth AT game_end OR
         last_player_not_bankrupt
```

**Multiplayer Free-for-all (Bomberman, SSB64):**
```
winner = last_player_alive OR
         player_with_highest_score_at_time_limit
```

---

## Fiber Channel + Agent Wallet

### Wager Escrow Flow

```
Player A funds:    0.5 CKB ──→ [Agent Fiber Channel: WAITING_FOR_B]
Player B funds:    0.5 CKB ──→ [Agent Fiber Channel: CHANNEL_READY]
                              (Total pool: 1.0 CKB locked)

Play game, agent watches RAM
│
├─ Player A wins → Settlement tx sends 1.0 CKB to Player A's address
├─ Player B wins → Settlement tx sends 1.0 CKB to Player B's address
└─ Error/dispute → Refund both halves to respective player channels
```

### Agent Wallet Responsibilities

1. **Channel opener:** Create Fiber channel with combined wager pool
2. **Game arbiter:** Watch RAM, accumulate scores, detect game end
3. **Settlement builder:** Create CKB unlock tx with winner payload
4. **Payout executor:** Send settlement tx via Fiber RPC

### Security Considerations

- **Channel timeout:** Auto-refund if opponent doesn't fund within 5 min
- **Dispute resolution:** If RAM corruption detected, refund both players
- **Oracle trust:** RAM engine is the oracle — game definition must be locked pre-match
- **Double-spend:** Only one settlement tx per wager (idempotent via cell deps)

---

## Game Definition Schema Extension

Each game definition gains multiplayer metadata:

```json
{
  "id": "street-fighter-2-turbo",
  "name": "Street Fighter II Turbo",
  "multiplayer": {
    "mode": "1v1",
    "supported_formats": ["best_of_1", "best_of_3", "best_of_5"],
    "players": 2,
    "controller_layout": {
      "p1": { "buttons": ["A", "B", "C", "X", "Y", "Z"], "analog": false },
      "p2": { "buttons": ["A", "B", "C", "X", "Y", "Z"], "analog": false }
    }
  },
  "wager": {
    "currencies": ["CKB"],
    "min_stake": "0.01",
    "max_stake": "100",
    "default_stakes": ["0.1", "0.5", "1.0", "5.0"]
  },
  "scoring": {
    "metric": "hp_remaining",
    "calculation": "max(p1_hp, p2_hp)",
    "tiebreaker": "round_wins"
  },
  "addresses": {
    "p1_hp": "0x0530",
    "p2_hp": "0x0536",
    "p1_rounds": "0x021A",
    "p2_rounds": "0x021B",
    "game_phase": "0x0180",
    "match_end_flag": "0x0500"
  }
}
```

---

## Mini App Integration

The Telegram Mini App gains a **"Wager" tab:**

```
Home | Chain | Research | Lounge | Members | Wager ← NEW
```

Wager tab features:
- **Active wagers:** List of live matches you're in
- **Wager history:** Past matches + payouts
- **Invite codes:** Share wager lobbies
- **Game browser:** Browse multiplayer games available for wagering
- **Leaderboard:** Top players by winnings (optional)

---

## Roadmap

### Phase 1 (Current — Hackathon, due March 25)
- ✅ Single-player tournament agent (RAM engine + Fiber payouts)
- ✅ Multi-player game definitions (SF2, Mario Kart, etc.)
- ✅ ROM verification (anti-cheat)

### Phase 2 (Post-hackathon Q2 2026)
- [ ] Wager setup UI (login + funding)
- [ ] Peer-to-peer channel opener
- [ ] Multiplayer game arbiter (watching 2+ RAM streams)
- [ ] Settlement builder (2-player vs 4-player payouts)
- [ ] Mini app wager tab

### Phase 3 (Q3+ 2026)
- [ ] Leaderboard + reputation system
- [ ] Dispute resolution oracle
- [ ] In-game overlay (show live wager status)
- [ ] Streaming integration (Twitch proof-of-play)

---

## Why This Matters

**Tournament organizers** run 1-many matches. **Players** want direct 1-on-1 wagering.

Both are valid. FiberQuest becomes a platform for:
1. **Organized tournaments** (creator-hosted, fixed entry fee, structured bracket)
2. **Casual peer wagering** (player-initiated, any game, any stakes)

This positions FiberQuest as the "DEX of retro gaming" — permissionless, trustless, autonomous settlement.

---

## Questions to Resolve

1. **Invite mechanism:** How do players find each other? Telegram bot commands? QR codes?
2. **Streaming proof:** Should matches be timestamped + recorded for tournament legitimacy?
3. **Rake/fees:** Does the agent take a small % of winning pools for sustainability?
4. **Reputation:** Should players have win/loss records visible in the UI?
5. **Stake limits:** Are there per-match or per-day limits to prevent collapse?
