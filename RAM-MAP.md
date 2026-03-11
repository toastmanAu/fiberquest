# FiberQuest — RAM Address Map & Gap Analysis

> Generated from all 23 game JSONs in `fiberquest/games/`
> Confidence: ✅ high | ⚠️ medium | ❌ low / needs verification

---

## MAPPED ADDRESSES BY GAME

### 🎮 ARCADE (fbneo core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| Pac-Man | score_p1 | 0x4E80 | uint8[3] BCD | ⚠️ |
| Pac-Man | lives | 0x4BE0 | uint8 | ⚠️ |
| Pac-Man | level | 0x4E00 | uint8 | ⚠️ |
| SF2 Turbo (CPS1) | p1_hp | 0x0530 | uint8 | ✅ |
| SF2 Turbo | p2_hp | 0x0536 | uint8 | ✅ |
| SF2 Turbo | p1_rounds | 0x021A | uint8 | ✅ |
| SF2 Turbo | p2_rounds | 0x021B | uint8 | ✅ |
| SF2 Turbo | game_phase | 0x0180 | uint8 | ✅ |
| Simpsons | p1_lives | 0x0083 | uint8 | ❌ verify |
| Simpsons | p2_lives | 0x008B | uint8 | ❌ verify |
| Simpsons | p1_health | 0x0082 | uint8 | ❌ verify |
| Simpsons | p2_health | 0x008A | uint8 | ❌ verify |
| Simpsons | credits | 0x0050 | uint8 | ⚠️ |

### 🎮 NES (fceumm core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| Super Mario Bros | lives | 0x075A | uint8 | ✅ |
| Super Mario Bros | world | 0x075F | uint8 | ✅ |
| Super Mario Bros | level | 0x0760 | uint8 | ✅ |
| Super Mario Bros | coins | 0x075E | uint8 | ✅ |
| Super Mario Bros | score (3 bytes BCD) | 0x07DD-0x07DF | bcd | ✅ |
| Super Mario Bros | game_state | 0x0770 | uint8 | ✅ |
| SMB3 | p1_lives | 0x0736 | uint8 | ✅ |
| SMB3 | p1_score (3B BCD) | 0x07D7 | bcd | ✅ |
| SMB3 | world | 0x0727 | uint8 | ✅ |
| SMB3 | power_up | 0x00ED | uint8 | ✅ |
| SMB3 | timer (3B BCD) | 0x05EE | bcd | ✅ |
| Tetris | score (3 bytes BCD) | 0x0073-0x0075 | bcd | ✅ |
| Tetris | lines (2 bytes BCD) | 0x0070-0x0071 | bcd | ✅ |
| Tetris | level | 0x0064 | uint8 | ✅ |
| Tetris | next_piece | 0x00BF | uint8 | ✅ |
| Double Dragon | p1_lives | 0x0043 | uint8 | ✅ |
| Double Dragon | p1_health | 0x0042 | uint8 | ✅ |
| Double Dragon | p2_lives | 0x004F | uint8 | ⚠️ verify |
| Double Dragon | timer | 0x0054 | uint8 | ✅ |
| Bubble Bobble | p1_lives | 0x002E | uint8 | ✅ |
| Bubble Bobble | p2_lives | 0x0042 | uint8 | ✅ |
| Bubble Bobble | round | 0x0401 | uint8 | ✅ |
| Bubble Bobble | timer | 0x040D | uint8 | ✅ |
| Bubble Bobble | p1_invincibility | 0x003F | uint8 | ✅ |

### 🎮 SNES (snes9x core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| Super Metroid | energy | 0x09C2 | uint16_le | ⚠️ |
| Super Metroid | max_energy | 0x09C4 | uint16_le | ⚠️ |
| Super Metroid | missiles | 0x09C8 | uint16_le | ⚠️ |
| Super Metroid | game_state | 0x0998 | uint8 | ⚠️ |
| Super Metroid | room_id | 0x079B | uint16_le | ⚠️ |
| DKC | p1_lives | 0xA863 | uint8 | ⚠️ verify |
| DKC | kong_status | 0x8FA4 | uint8 | ⚠️ verify |
| DKC | level_complete | 0x8E84 | uint8 | ⚠️ verify |
| MK SNES | p1_health | 0x04B9 | uint8 | ✅ |
| MK SNES | p2_health | 0x04BB | uint8 | ✅ |
| MK SNES | timer | 0x0122 | uint8 | ✅ |
| ClayFighter 2 | p1_health | 0x1828 | uint8 | ✅ |
| ClayFighter 2 | p2_health | 0x1B14 | uint8 | ✅ |
| ClayFighter 2 | timer | 0x0FC6 | uint8 | ✅ |

### 🎮 MEGA DRIVE (genesis_plus_gx core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| Sonic 1 MD | lives | 0xFFFE12 | uint8 | ✅ |
| Sonic 1 MD | rings | 0xFFFE20 | uint16_be | ✅ |
| Sonic 1 MD | score | 0xFFFE26 | uint32_be | ✅ |
| Sonic 1 MD | stage_act | 0xFFFE10 | uint16_be | ✅ |
| Sonic 1 MD | timer_min | 0xFFFE24 | uint8 | ✅ |
| Sonic 2 MD | lives | 0xFFFE12 | uint8 | ✅ |
| Sonic 2 MD | rings | 0xFFFE20 | uint16_be | ✅ |
| Sonic 2 MD | score | 0xFFFE26 | uint32_be | ✅ |
| Sonic 2 MD | stage_act | 0xFFFE10 | uint16_be | ✅ |
| Sonic 2 MD | timer | 0xFFFE24 | uint16_be | ✅ |
| Golden Axe | p1_lives | 0xFFFE7C | uint8 | ✅ |
| Golden Axe | p2_lives | 0xFFFE8C | uint8 | ✅ |
| Golden Axe | p1_health | 0xFFFE7E | uint8 | ✅ |
| Golden Axe | p2_health | 0xFFFE8E | uint8 | ✅ |
| Golden Axe | p1_magic | 0xFFFE80 | uint8 | ✅ |
| Golden Axe | stage | 0xFFFE2D | uint8 | ✅ |
| Golden Axe | credits | 0xFFFE34 | uint8 | ✅ |
| SoR2 | p1_lives | 0xFFEF83 | uint8 | ✅ |
| SoR2 | p1_health | 0xFFEF81 | uint8 | ✅ |
| SoR2 | p1_score (3B BCD) | 0xFFEF96-98 | bcd | ⚠️ |
| SoR2 | p2_lives | 0xFFF083 | uint8 | ✅ |
| SoR2 | p2_health | 0xFFF081 | uint8 | ✅ |
| SoR2 | p2_score (3B BCD) | 0xFFF096-98 | bcd | ⚠️ |
| SoR2 | stage | 0xFFFC3C | uint8 | ✅ |
| Altered Beast | p1_lives | 0xFFB120 | uint8 | ✅ |
| Altered Beast | p2_lives | 0xFFB126 | uint8 | ✅ |
| Altered Beast | p1_health | 0xFFCF10 | uint8 | ✅ |
| Altered Beast | p2_health | 0xFFCF50 | uint8 | ✅ |
| Altered Beast | p1_power_up | 0xFFD02B | uint8 | ✅ |
| Altered Beast | p2_power_up | 0xFFD06B | uint8 | ✅ |
| Altered Beast | stage | 0xFFFE15 | uint8 | ✅ |

### 🎮 MASTER SYSTEM (genesis_plus_gx core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| Alex Kidd | lives | 0xC02F9 | uint8 | ⚠️ |
| Alex Kidd | money | 0xC030 | uint16_be | ⚠️ |
| Alex Kidd | score | 0xC032 | uint16_be | ⚠️ |
| Sonic SMS | score | 0xD2BA | uint32_be | ✅ |
| Sonic SMS | lives | 0xD246 | uint8 | ✅ |
| Sonic SMS | current_act | 0xD23E | uint8 | ✅ |
| Sonic SMS | rings | 0xD2AA | uint8 | ✅ |
| Sonic SMS | emeralds | 0xD27F | uint8 | ✅ |
| Sonic SMS | timer_ms | 0xD2D0 | uint8 | ✅ |
| MK SMS | p1_health | 0xC488 | uint8 | ✅ |
| MK SMS | p2_health | 0xC48A | uint8 | ✅ |
| MK SMS | timer | 0xC436 | uint8 | ✅ |

### 🎮 N64 (mupen64plus_next core)

| Game | Field | Address | Type | Confidence |
|------|-------|---------|------|-----------|
| GoldenEye | p1_kills | 0x079F1B | uint8 | ✅ |
| GoldenEye | p2_kills | 0x079F87 | uint8 | ✅ |
| GoldenEye | p3_kills | 0x079FFB | uint8 | ✅ |
| GoldenEye | p4_kills | 0x07A06F | uint8 | ✅ |
| GoldenEye | p1_deaths | 0x0CA53B | uint8 | ✅ |
| GoldenEye | p2_deaths | 0x0CCFBB | uint8 | ✅ |
| GoldenEye | p3_deaths | 0x0CFA3B | uint8 | ✅ |
| GoldenEye | p4_deaths | 0x0D24BB | uint8 | ✅ |
| GoldenEye | health_mode | 0x02B499 | uint8 | ✅ |
| Mario Kart 64 | p1_laps | 0x164390 | uint32_be | ⚠️ verify |
| Mario Kart 64 | p2_laps | 0x164394 | uint32_be | ⚠️ verify |
| Mario Kart 64 | p3_laps | 0x164398 | uint32_be | ⚠️ verify |
| Mario Kart 64 | p4_laps | 0x16439C | uint32_be | ⚠️ verify |
| Mario Kart 64 | p1_balloons | 0x18D8C0 | uint16_be | ⚠️ verify |
| Mario Kart 64 | p2_balloons | 0x18D8C2 | uint16_be | ⚠️ verify |
| Mario Kart 64 | p3_balloons | 0x18D8C4 | uint16_be | ⚠️ verify |
| Mario Kart 64 | p4_balloons | 0x18D8C6 | uint16_be | ⚠️ verify |
| Smash Bros N64 | p1_stocks | 0x0A4B43 | uint8 | ✅ |
| Smash Bros N64 | p2_stocks | 0x0A4BB7 | uint8 | ✅ |
| Smash Bros N64 | p3_stocks | 0x0A4C2B | uint8 | ✅ |
| Smash Bros N64 | p4_stocks | 0x0A4C9F | uint8 | ✅ |

---

## GAP ANALYSIS — What's Missing & Worth Adding

### 🔴 CRITICAL GAPS (blocks tournament operation)

| Game | Missing | Impact | Effort to map |
|------|---------|--------|--------------|
| **Simpsons Arcade** | All addresses unverified | Can't run live sessions | Medium — need to play + watch RAM |
| **Pac-Man** | Score/lives unverified | BCD decode unconfirmed | Low — well-documented MAME |
| **Mario Kart 64** | Laps/balloons unverified | Race/battle format broken | Low — just needs a test run |
| **DKC** | All addresses uncertain | Race format unreliable | Medium — bank addressing complexity |
| **Bubble Bobble** | No P2 score tracking | Co-op format loses richness | Low — score likely near P1 score addr |
| **SoR2** | Score BCD format unverified | Scoring tournament broken | Low — just needs decode test |

### 🟡 VALUABLE ADDITIONS (not mapped, but worth having)

#### Gameplay State / Round Detection
Most games are **missing a "round/match state" address** — we can't detect *when* a round starts or ends, just that HP hit zero. This matters for automatic payout triggers.

| Need | Games affected | What to look for |
|------|---------------|-----------------|
| Round state byte | MK SNES, MK SMS, CF2 | Changes between: fighting / KO animation / result screen |
| Match wins counter | All fighters | Count of rounds won per player |
| Game over / attract mode | All games | Detect session end cleanly |
| Player count active | GoldenEye, MK64, Smash | Which player slots are actually filled |

#### Score Tracking (missing from beat-em-ups)
Games with scores that we're NOT tracking:

| Game | Missing | Notes |
|------|---------|-------|
| **Double Dragon** | Score | No score address mapped at all |
| **Altered Beast** | Score | Only lives/health mapped |
| **Golden Axe** | Score | Only lives/health/magic mapped |
| **Bubble Bobble** | P1 score, P2 score | Score not tracked — only round number |
| **Simpsons** | Score (P1-P4) | Missing entirely |

#### 4-Player Data (partial maps)
| Game | P3/P4 missing |
|------|--------------|
| **Simpsons Arcade** | P3 lives @ ~0x0093, P4 lives @ ~0x009B (estimated — needs verify) |
| **GoldenEye** | P1 health (not just kills/deaths) |
| **Mario Kart 64** | Position/rank address (1st/2nd etc) — very useful for race mode |

#### Power/Item State (useful for rich tournament data)
| Game | What's mappable | Value |
|------|----------------|-------|
| **GoldenEye** | Current weapon (per player) | Weapon restriction enforcement |
| **MK SNES/SMS** | Character select byte | Auto-detect who picked who |
| **Smash Bros** | Damage % (not stocks) | Better KO prediction |
| **Mario Kart 64** | Current item held | Could trigger item-based side bets |
| **Super Metroid** | Super missiles, power bombs, items collected | Richer race metric |
| **Sonic games** | Shield type, invincibility frames | Star bonus event triggers |

#### Time / Speed Metrics
| Game | Missing | Notes |
|------|---------|-------|
| **Mario Kart 64** | Race finish time | Address unknown — valuable for tie-breaking |
| **Super Metroid** | In-game timer | For any% race — current IGT not mapped |
| **GoldenEye** | Match time remaining | Round timer |

### 🟢 SELF-MAPPABLE (straightforward to verify yourself)

These you can map in a single RetroArch session with the memory viewer:

1. **Simpsons P1/P2/P3/P4 lives & score** — open memory viewer, start game, lose a life, watch what decrements. 30 mins tops.
2. **MK SNES rounds_won counter** — win a round, watch for increment near the HP addresses. Should be within 0x10 bytes.
3. **SoR2 score verification** — play for 30 seconds, cross-reference the BCD decode with on-screen score.
4. **MK64 position/rank** — start a race, trail in last place, watch for a byte that reads 0x04 (4th) and changes on overtake.
5. **Double Dragon score** — near the lives address (0x0043), look for BCD-formatted bytes that increment on kills.
6. **Bubble Bobble P1/P2 score** — likely near 0x0060-0x0090 range, BCD. Both players will have separate blocks.

### 🔵 MISSING GAMES (high tournament value, not yet mapped)

| Game | Platform | Why it's good | Map effort |
|------|----------|--------------|-----------|
| **Bomberman** | SNES/N64 | Perfect 4-player elimination | Low — lives counter easy to find |
| **NBA Jam** | SNES/MD | Score-based, huge crowd appeal | Low — game score well-documented |
| **WWF Royal Rumble** | SNES | Elimination format fits CKB perfectly | Medium |
| **Contra** | NES | Co-op lives race, legendary | Low — NES, simple RAM |
| **Punchout** | NES | KO-based 1v1 with health bar | Low — confirmed in cheat DB |
| **Bomberman 64** | N64 | 4P battle mode, explosive | Medium |
| **Mario Party 64** | N64 | Mini-games = natural bet structure | High — complex |
| **Kirby Superstar** | SNES | Co-op with HP, approachable | Low |
| **Teenage Mutant Ninja Turtles** (arcade) | Arcade/NES | 4P co-op, brand recognition | Medium |

---

## VERIFICATION PRIORITY

Order to verify first (biggest unlock per hour of effort):

1. ✅ **Simpsons Arcade** — most impactful missing map. Flagship game.
2. ✅ **Mario Kart 64 laps/balloons** — N64 party format, easy to verify
3. ✅ **MK SNES rounds_won** — adds proper round-win detection to all fighter games
4. ✅ **Bubble Bobble scores** — makes co-op mode actually trackable
5. ✅ **Double Dragon score** — only beat-em-up with zero score tracking

---

## RETROARCH MEMORY VIEWER — HOW TO MAP

1. Load game in RetroArch
2. Menu → Tools → Memory Viewer (or press F11)
3. Set search type to match what you're hunting (8-bit, BCD, etc.)
4. Change game state (lose a life, gain a coin) → hit "Search Changed" or "Search Decreased"
5. Narrow down until 1-3 candidates remain
6. Confirm by writing the value (cheat test) — does the on-screen value change?
7. Note address → update the game JSON

---

## GL / RENDERING NOTES (for pi deployment)

- driveThree: RTX 3060 Ti — GL works but **requires physical desktop login or VirtualGL over SSH**
- Pi 5: needs `mesa-vulkan-drivers` + `libgles2-mesa` for RetroArch GL
- Fix for SSH launching: `export LIBGL_ALWAYS_SOFTWARE=1` (slow but universal fallback for testing)
- Production: Pis will run RetroArch natively at physical display — no SSH GL issues
- For headless poller-only use: RetroArch doesn't need to be on the Pi — just the UDP poller connecting to wherever RetroArch runs

