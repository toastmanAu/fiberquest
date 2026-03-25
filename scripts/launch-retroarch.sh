#!/bin/bash
# Launch RetroArch in a completely fresh systemd scope — fully isolated from
# Electron's process tree, cgroups, signal handlers, and file descriptors.
systemd-run --user --scope --quiet flatpak run org.libretro.RetroArch "$@" &
