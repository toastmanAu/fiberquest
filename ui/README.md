# FiberQuest UI Design System

## Directory Structure
```
ui/
├── README.md (this file)
├── DESIGN-SYSTEM.md (colors, fonts, components, retro aesthetic)
├── SCREENS.md (all screen mockups with ASCII art)
├── FLOWS.md (user journeys, interaction flows)
├── components/ (reusable UI component specs)
│   ├── button.md
│   ├── input.md
│   ├── modal.md
│   └── overlay.md
├── pages/ (full page designs)
│   ├── tournament-home.md
│   ├── wager-setup.md
│   ├── match-lobby.md
│   ├── game-screen.md
│   └── results.md
└── assets/ (logos, icons, color palette)
    ├── colors.md
    ├── typography.md
    └── icons.md
```

## Design Philosophy

**"Press Start 2P"** — Retro arcade aesthetic meets modern wagering UX

- **Style:** Pixel-art inspired, retro gaming vibes
- **Font:** Press Start 2P (heading), monospace (data)
- **Colors:** High contrast, neon accents (retro CRT feel)
- **Interaction:** Keyboard-first (arcade buttons), mouse optional
- **Density:** Information-packed but scannable

## Phase 1 UI Priorities (Hackathon)

### Essential Screens
1. ✅ **Tournament Home** — Show available tournaments
2. ✅ **Entry Screen** — Choose game, pay entry, join tournament
3. ✅ **Game Screen** — Live match with score display
4. ✅ **Results** — Winner + payout confirmation

### Phase 2 UI (Peer Wagering)
1. 📋 **Wager Setup** — Login, game select, amount, format
2. 📋 **Wager Lobby** — Invite codes, wait for opponent
3. 📋 **Match Display** — Both players' scores, wager amount
4. 📋 **Settlement** — Winner confirmation, Fiber tx hash

## Current Design Documents

### Multiplayer Wagering UI (Phase 2)
See: `MULTIPLAYER-WAGERING.md` (in parent directory)
- Full wager flow with ASCII mockups
- 5 screen designs (setup, lobby, match, results, settlement)

### Game-Specific Considerations
- **Fighting games (SF2, MK3):** HP bars, round counters, round timer
- **Racing (Mario Kart):** Position indicator, lap counter, finish line detection
- **Economic (Monopoly):** Player wealth display, property ownership
- **Puzzle (Wheel of Fortune):** Category display, score board, guesses remaining

## TODO: Build These Docs

- [ ] DESIGN-SYSTEM.md — Color palette, typography, component library
- [ ] SCREENS.md — Comprehensive mockup collection (ASCII art)
- [ ] FLOWS.md — User journey diagrams (login → wager → play → settle)
- [ ] components/ folder with individual component specs
- [ ] pages/ folder with page-by-page designs

## Implementation Notes

**Framework:** Electron + vanilla JS (no React) for hackathon simplicity
**Retro UI Library:** Consider [chiptone.io](https://chiptone.io) for sound effects + visuals
**Fonts:** Google Fonts (Press Start 2P, Courier New for monospace)
**Colors:** Neon palette inspired by arcade cabinets

## Questions to Resolve

1. **Overlay transparency:** Should game screen be behind the UI (50% opacity)?
2. **Mobile support:** Is this Electron desktop-only or Telegram mini app too?
3. **Accessibility:** Need high-contrast mode for visibility?
4. **Sound effects:** Do we bleep/bloop on button presses?
5. **Animation:** How snappy should transitions be? (retro CRT flicker effect?)

---

**Last updated:** 2026-03-14 03:05 ACST
**Status:** Skeleton created, ready for design iteration
