#!/bin/bash
# FiberQuest launcher — auto-detects display environment (Wayland/X11)
# Used by: npm start, desktop shortcut, AppImage wrapper

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# ── Display detection ─────────────────────────────────────────
UID_NUM=$(id -u)
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_NUM}"

if [ -z "$WAYLAND_DISPLAY" ] && [ -z "$DISPLAY" ]; then
  if [ -S "$RUNTIME_DIR/wayland-0" ]; then
    export WAYLAND_DISPLAY=wayland-0
    export XDG_RUNTIME_DIR="$RUNTIME_DIR"
    echo "[FQ] Auto-detected Wayland (wayland-0)"
  elif [ -S "/tmp/.X11-unix/X0" ]; then
    export DISPLAY=:0
    echo "[FQ] Auto-detected X11 (:0)"
  else
    echo "[FQ] WARNING: No display detected — UI may not appear"
  fi
fi

# Ensure XDG_RUNTIME_DIR is set (needed by Electron + flatpak)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$RUNTIME_DIR}"

# ── Electron flags for Wayland ────────────────────────────────
ELECTRON_FLAGS=""
if [ -n "$WAYLAND_DISPLAY" ]; then
  ELECTRON_FLAGS="--ozone-platform=wayland --enable-features=WaylandWindowDecorations"
fi

# ── Launch ────────────────────────────────────────────────────
exec npx electron $ELECTRON_FLAGS .
