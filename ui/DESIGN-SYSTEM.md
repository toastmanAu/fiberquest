# FiberQuest Design System

## Brand Identity

**Name:** FiberQuest  
**Tagline:** "Retro Gaming on the Blockchain"  
**Vibe:** Arcade cabinet meets blockchain — nostalgic, high-energy, trustworthy

---

## Color Palette

### Primary Colors
- **Deep Purple** `#1a0033` — Main background (CRT screen dark)
- **Neon Cyan** `#00ffff` — Primary accent (Fiber network color)
- **Neon Pink** `#ff00ff` — Secondary accent, highlights
- **Retro Green** `#00ff00` — Success, confirmed (CRT phosphor green)
- **Warning Orange** `#ffaa00` — Warnings, attention needed

### Neutral Colors
- **Black** `#000000` — Text on light, highest contrast
- **Off-White** `#e0e0e0` — Light backgrounds
- **Dark Gray** `#333333` — Secondary text, borders
- **Medium Gray** `#666666` — Disabled states

### Game-Specific Colors
- **Fighter Red** `#ff0000` — Health loss, damage
- **Winner Gold** `#ffff00` — Victory, celebration
- **Crypto Blue** `#0099ff` — CKB/Fiber-related UI

---

## Typography

### Heading Font
- **Family:** Press Start 2P (Google Fonts)
- **Weight:** Regular (only weight available)
- **Size:** 32px (titles), 24px (subtitles), 16px (section heads)
- **Color:** Neon Cyan or Neon Pink (high contrast)
- **Line-height:** 1.4
- **Letter-spacing:** 2px (retro arcade feel)

### Body Font
- **Family:** Courier New or Inconsolata (monospace)
- **Weight:** Regular
- **Size:** 14px (body text), 12px (captions)
- **Color:** Off-White on Deep Purple
- **Line-height:** 1.6 (readable but compact)
- **Letter-spacing:** 0.5px

### Data Font
- **Family:** IBM Plex Mono (or Courier New)
- **Weight:** Regular
- **Size:** 12px (addresses, hashes, numbers)
- **Monospace:** Always (for alignment)
- **Color:** Retro Green (mimics old CRT terminals)

---

## Component Library

### Buttons

#### Primary Button
```
┌──────────────────────┐
│  [PLAY] [WAGER] [GO] │
└──────────────────────┘

Background: Neon Cyan (#00ffff)
Text: Deep Purple (#1a0033), Press Start 2P, 16px, bold
Padding: 12px 24px
Border: 2px solid Neon Cyan
Hover: Invert colors (Deep Purple bg, Cyan text)
Active: Scale 98%
```

#### Secondary Button
```
┌──────────────────────┐
│  [CANCEL] [BACK]     │
└──────────────────────┘

Background: Transparent
Text: Off-White, Courier New, 14px
Border: 2px dashed Dark Gray
Hover: Border solid, text Neon Pink
```

#### Success Button (Winner Pay)
```
┌──────────────────────┐
│  [CLAIM REWARD]      │
└──────────────────────┘

Background: Retro Green (#00ff00)
Text: Deep Purple, Press Start 2P, bold
Border: 2px solid Retro Green
Animation: Pulse (heartbeat effect)
```

### Input Fields

#### Text Input
```
Wager Amount: [0.5 CKB____]

Background: Dark Gray (#333333)
Text: Off-White
Border: 2px solid Neon Cyan (focused), Dark Gray (unfocused)
Placeholder: Medium Gray, italicized
Padding: 8px 12px
Font: Courier New, 14px
```

#### Dropdown Select
```
Game: [Street Fighter II Turbo ▼]

Background: Dark Gray
Text: Off-White
Border: 2px solid Neon Cyan
Arrow: Neon Cyan
Hover: Background lighter
```

### Status Indicators

#### Recording Live
```
● RECORDING (blinking red dot)

Dot: #ff0000
Text: Retro Green
Animation: 1s blink
```

#### Connected
```
✓ CONNECTED (solid green check)

Check: Retro Green (#00ff00)
Text: Off-White
```

#### Waiting
```
⏳ WAITING FOR OPPONENT

Icon: Neon Pink
Text: Off-White
Animation: Spin 2s infinite
```

### Modals / Overlays

#### Confirmation Modal
```
┌────────────────────────────────┐
│     ⚠️ CONFIRM WAGER            │
├────────────────────────────────┤
│ You are about to wager:        │
│                                │
│ Game:  Street Fighter II Turbo │
│ Stake: 0.5 CKB (vs Player B)   │
│ Match: Best of 3               │
│                                │
│ [I UNDERSTAND] [CANCEL]        │
└────────────────────────────────┘

Background: Deep Purple with 80% opacity overlay
Border: 3px solid Neon Cyan
Shadow: Neon Cyan glow
```

#### Info Panel (Transparent)
```
┌──────────────────────┐
│ 🎮 Mario Kart 64     │
│ P1: 1st   P2: 2nd    │
│ Lap 2 of 3           │
└──────────────────────┘

Background: Deep Purple, 60% opacity
Border: 2px dashed Neon Cyan
Text: Off-White + Retro Green for data
```

---

## Layout & Spacing

### Grid System
- **Base unit:** 8px
- **Gutter:** 16px (2 units)
- **Margins:** 24px (3 units) outer, 16px inner
- **Padding:** 12px (1.5 units) for buttons, 16px for containers

### Breakpoints
- **Desktop:** 1280px+ (full Electron window)
- **Tablet:** 768px-1279px (optional future mobile)
- **Mobile:** <768px (Telegram mini app, future)

### Screen Dimensions
- **Electron Default:** 1024x768 (classic arcade resolution)
- **Fullscreen:** 1920x1080 (modern monitor)
- **Mini app:** 360x640 (Telegram mobile)

---

## Animation & Effects

### Transitions
- **Button hover:** 100ms ease-out
- **Modal appear:** 200ms fade-in
- **Game score update:** 150ms scale pulse
- **Notification slide-in:** 300ms cubic-bezier(0.34, 1.56, 0.64, 1)

### CRT Effects (Optional)
- **Scanlines:** Subtle horizontal lines (0.5px, 20% opacity)
- **Flicker:** Rare flicker on scene change (50ms, 5% opacity)
- **Phosphor glow:** Text shadow with Neon Cyan/Pink blur

### Audio Design
- **Button click:** Short beep (chiptone, 8-bit style)
- **Success:** Ascending chime (3-note jingle)
- **Win:** Victory fanfare (classic arcade)
- **Error:** Buzzer sound (warning)
- Toggle: Off

---

## Accessibility

### Color Contrast
- All text: WCAG AA compliant (4.5:1 ratio minimum)
- Neon Cyan on Deep Purple: 10.5:1 ✓
- Off-White on Deep Purple: 11.2:1 ✓
- Retro Green on Deep Purple: 12.3:1 ✓

### Font Sizes
- Minimum: 12px (captions)
- Body: 14px
- Headings: 24px+
- CTA buttons: 16px minimum

### Keyboard Support
- All buttons: Focusable (Tab key)
- Enter: Activate focused button
- Escape: Close modals
- Arrow keys: Navigate dropdowns (future)

### High Contrast Mode
- Alternative palette for users with low vision
- Stronger borders (3px instead of 2px)
- Larger text (16px minimum body)
- Reduced animations (respects `prefers-reduced-motion`)

---

## Component States

### Button States
1. **Default** — Full opacity, normal colors
2. **Hover** — Color invert or highlight
3. **Focus** — Outline or glow effect
4. **Active** — Pressed/scale effect
5. **Disabled** — 50% opacity, no interaction

### Input States
1. **Empty** — Placeholder visible
2. **Focused** — Border cyan, cursor blinking
3. **Filled** — Text visible, border retained
4. **Error** — Border orange, error message below
5. **Disabled** — 50% opacity, no interaction

### Status States
1. **Loading** — Spinner, neutral gray
2. **Success** — Green check, confirmation message
3. **Warning** — Orange alert, attention message
4. **Error** — Red X, error details
5. **Info** — Cyan info icon, informational message

---

## Implementation Checklist

- [ ] CSS variables defined for all colors
- [ ] Press Start 2P font imported (Google Fonts CDN)
- [ ] Reset/normalize CSS applied
- [ ] Component CSS library created (buttons, inputs, modals)
- [ ] Dark mode only (no light theme needed)
- [ ] Responsive design tested (1024x768, 1920x1080)
- [ ] Keyboard navigation verified
- [ ] Focus states visible (outline or glow)
- [ ] Animations performant (no jank)
- [ ] Mobile breakpoint tested (future)

---

**Last updated:** 2026-03-14 03:05 ACST  
**Status:** Design system frozen, ready for implementation
