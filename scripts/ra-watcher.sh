#!/bin/bash
# RetroArch launch watcher — runs alongside FiberQuest.
# Electron writes launch commands to /tmp/fq-ra-launch.cmd
# This script watches for them and launches RetroArch independently.
CMDFILE=/tmp/fq-ra-launch.cmd
echo "[ra-watcher] Watching $CMDFILE for launch commands..."
rm -f "$CMDFILE"

while true; do
  if [ -f "$CMDFILE" ]; then
    CMD=$(cat "$CMDFILE")
    rm -f "$CMDFILE"
    echo "[ra-watcher] Launching: $CMD"
    eval "$CMD" &
  fi
  sleep 1
done
