#!/bin/bash
# RetroArch launch watcher — runs alongside FiberQuest.
# Electron writes launch commands to /tmp/fq-ra-launch.cmd
# This script watches for them and launches RetroArch independently.
CMDFILE=/tmp/fq-ra-launch.cmd
echo "[ra-watcher] Watching $CMDFILE for launch commands..."
rm -f "$CMDFILE"

# ── Ensure display env vars are set for Wayland and X11 ──────
# When launched from Electron (which has the desktop session env),
# these should already be inherited. But if not, detect them.
if [ -z "$WAYLAND_DISPLAY" ] && [ -z "$DISPLAY" ]; then
  # Try to detect Wayland
  if [ -S "/run/user/$(id -u)/wayland-0" ]; then
    export WAYLAND_DISPLAY=wayland-0
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    echo "[ra-watcher] Auto-detected Wayland (wayland-0)"
  # Try to detect X11
  elif [ -S "/tmp/.X11-unix/X0" ]; then
    export DISPLAY=:0
    echo "[ra-watcher] Auto-detected X11 (:0)"
  fi
fi

while true; do
  if [ -f "$CMDFILE" ]; then
    CMD=$(cat "$CMDFILE")
    rm -f "$CMDFILE"
    echo "[ra-watcher] Launching: $CMD"
    echo "[ra-watcher] WAYLAND_DISPLAY=$WAYLAND_DISPLAY DISPLAY=$DISPLAY XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
    eval "$CMD" > /tmp/ra-launch.log 2>&1 &
    RA_PID=$!
    sleep 2
    if kill -0 $RA_PID 2>/dev/null; then
      echo "[ra-watcher] RetroArch started (PID $RA_PID)"
    else
      echo "[ra-watcher] RetroArch failed to start. Log:"
      cat /tmp/ra-launch.log 2>/dev/null
    fi
  fi
  sleep 1
done
