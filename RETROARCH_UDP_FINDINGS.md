# RetroArch UDP Network Commands - Diagnostic Findings

**Date:** 2026-03-22
**Status:** Partially Functional - Memory reading unavailable
**Machine:** FiberQuest Pi (192.168.68.84)
**RetroArch Version:** 1.18.0 (Apr 2, 2024, GCC 13.2.0, aarch64)

---

## What Works ✅

UDP network commands interface is **functional**:
- Network commands enabled: `network_cmd_enable = "true"`
- UDP port 55355 confirmed bound to RetroArch process (lsof verified)
- VERSION command responds: `1.18.0`
- GET_STATUS command responds: `GET_STATUS PLAYING super_nes,Mortal Kombat,crc32=7ca113c9`

---

## What Doesn't Work ❌

Memory reading commands **do not respond**:
- `READ_CORE_MEMORY 0x1828` → no response
- `READ_CORE_MEMORY snes9x 0x1828` → no response
- `GET_MEMORY` → no response
- `MEMORY_GET` → no response
- `PEEK` / `DUMP_MEMORY` variants → no response

**Conclusion:** This RetroArch build (1.18.0) does not have core memory read commands compiled in, or they require a different protocol/format than expected.

---

## Root Cause Analysis

The UDP network command interface appears to have a limited command set in this build:
- Meta commands work (VERSION, GET_STATUS)
- Game/core control might be available (unclear - not tested)
- **Memory reading is not available**

This could be due to:
1. Compilation flags excluding memory read support
2. Different protocol version than SNES9x core expects
3. Additional configuration needed beyond `network_cmd_enable = true`

---

## Workarounds for Game State Polling

### Option 1: Lua Scripting (Recommended if available)
```
- Create RetroArch Lua script in ~/.config/retroarch/scripts/
- Script reads SNES RAM addresses and writes to a file/socket
- FiberQuest reads state from script output
```

**Status:** Scripts directory doesn't exist; would need setup

### Option 2: Direct Core Memory Access (Not Available)
```
- Use libretro core memory inspection tool
- Requires core to expose memory interface
```

**Status:** Not available in this build/core

### Option 3: Game State Mocking (Hackathon Quick Win)
```
- Create mock game state generator for demo
- Simulates tournament scoring without real gameplay
- Full integration tested with mock data
```

**Status:** Viable immediately, sufficient for hackathon demo

### Option 4: Alternative Emulator Interface
```
- Use QEMU/other emulator with built-in memory inspection
- Or use debugger interface (gdb stub) if available
```

**Status:** Would require setup, time intensive

---

## Recommendation for Hackathon (March 25 Deadline)

**Use Option 3 (Game State Mocking)** for immediate progress:

1. Create a mock RAM engine in FiberQuest that:
   - Simulates Mortal Kombat round/HP tracking
   - Generates random but plausible state changes
   - Matches expected RAM address format

2. This allows demonstrating:
   - ✅ Tournament creation and entry invoices
   - ✅ Real Fiber payment flow (entry and payout)
   - ✅ End-to-end tournament lifecycle
   - ⚠️ Game state polling (mocked, but proves architecture)

3. Real game polling can be added post-hackathon once:
   - RetroArch memory read support is confirmed
   - Or alternative emulator/interface is integrated

---

## Technical Details for Future Investigation

If memory reading needs to work:

1. Check if `core_allows_cheats` needs enabling in retroarch.cfg
2. Verify snes9x core supports memory access protocol
3. Try connecting via netplay protocol instead of UDP commands
4. Check RetroArch build logs: `retroarch --features` if available
5. Test with official RetroArch build (vs custom aarch64-linux-gnu version)

---

## Files for Reference
- RetroArch config: `/home/phill/.config/retroarch/retroarch.cfg`
- Running core: `snes9x_libretro.so` at `/usr/lib/aarch64-linux-gnu/libretro/`
- Test script: `/tmp/test_polling.js` (polling test with 60Hz UDP commands)

