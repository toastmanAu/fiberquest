#!/bin/bash
# FiberQuest Game Launcher
# Run from driveThree's terminal — launches RetroArch + starts the RAM poller on Pi
# Usage: ./launch.sh [game_id]
# If no game_id given, shows menu.

CORES_DIR="$HOME/.var/app/org.libretro.RetroArch/config/retroarch/cores"
GAMES_DIR="$HOME/fiberquest/games"
ROMS_BASE="$HOME/roms"
XAUTH="/run/user/1000/gdm/Xauthority"
DISPLAY_ENV=":1"
LOG="/tmp/retroarch-fiberquest.log"
PI_HOST="phill@192.168.68.82"  # Pi5 (adjust if needed)
POLLER_SCRIPT="/home/phill/.openclaw/workspace/fiberquest/ram-logger/ram-logger.py"

# ──────────────────────────────────────────────
# Core map: platform → core .so name
# ──────────────────────────────────────────────
declare -A CORE_MAP=(
  ["nes"]="fceumm_libretro.so"
  ["snes"]="snes9x_libretro.so"
  ["megadrive"]="genesis_plus_gx_libretro.so"
  ["mastersystem"]="genesis_plus_gx_libretro.so"
  ["arcade"]="fbneo_libretro.so"
  ["n64"]="mupen64plus_next_libretro.so"
)

# ──────────────────────────────────────────────
# ROM path resolver: expands ~ and finds actual file
# ──────────────────────────────────────────────
resolve_rom() {
  local rom_path="$1"
  local platform="$2"

  rom_path="${rom_path/#\~/$HOME}"

  if [ -f "$rom_path" ]; then
    echo "$rom_path"
    return 0
  fi

  local basename
  basename=$(basename "$rom_path")
  local subdir
  case "$platform" in
    megadrive) subdir="megadrive" ;;
    n64) subdir="n64" ;;
    snes) subdir="snes" ;;
    nes) subdir="nes" ;;
    arcade) subdir="arcade" ;;
    *) subdir="" ;;
  esac

  if [ -n "$subdir" ]; then
    local try="$ROMS_BASE/$subdir/$basename"
    if [ -f "$try" ]; then
      echo "$try"
      return 0
    fi
    # Glob for partial name match
    local found
    found=$(ls "$ROMS_BASE/$subdir/"*"${basename%.*}"* 2>/dev/null | head -1)
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  fi

  echo ""
  return 1
}

# ──────────────────────────────────────────────
# List available games
# ──────────────────────────────────────────────
list_games() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║              🎮  FiberQuest Game Library                     ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  printf "  %-30s %-14s %-10s\n" "GAME ID" "PLATFORM" "FORMAT"
  echo "  ──────────────────────────────────────────────────────────────"

  for f in "$GAMES_DIR"/*.json; do
    local id platform format
    id=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('id','?'))" 2>/dev/null)
    platform=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('platform',d.get('system','?')))" 2>/dev/null)
    format=$(python3 -c "
import json
d=json.load(open('$f'))
tf=d.get('tournament_format','')
tm=d.get('tournament_modes')
if tf: print(tf)
elif tm and isinstance(tm,list): print(tm[0].get('id','?'))
else: print('?')
" 2>/dev/null)
    printf "  %-30s %-14s %-10s\n" "$id" "$platform" "$format"
  done
  echo ""
}

# ──────────────────────────────────────────────
# Launch a game
# ──────────────────────────────────────────────
launch_game() {
  local game_id="$1"
  local game_file="$GAMES_DIR/${game_id}.json"

  if [ ! -f "$game_file" ]; then
    echo "❌ No game file found: $game_file"
    echo "   Available:"
    ls "$GAMES_DIR"/*.json | xargs -I{} basename {} .json | sed 's/^/   - /'
    exit 1
  fi

  local platform rom_path core_name
  platform=$(python3 -c "import json; d=json.load(open('$game_file')); print(d.get('platform',d.get('system','')))" 2>/dev/null)
  rom_path=$(python3 -c "import json; d=json.load(open('$game_file')); print(d.get('rom',d.get('rom_name','')))" 2>/dev/null)
  core_name=$(python3 -c "import json; d=json.load(open('$game_file')); print(d.get('core',''))" 2>/dev/null)

  local core_so="${CORE_MAP[$platform]}"
  if [ -z "$core_so" ]; then
    core_so="${core_name}_libretro.so"
  fi

  local core_path="$CORES_DIR/$core_so"
  if [ ! -f "$core_path" ]; then
    echo "❌ Core not found: $core_path"
    exit 1
  fi

  local rom_resolved
  rom_resolved=$(resolve_rom "$rom_path" "$platform")
  if [ -z "$rom_resolved" ]; then
    echo "❌ ROM not found: $rom_path"
    echo "   Expected under $ROMS_BASE/$platform/"
    exit 1
  fi

  pkill -f 'retroarch' 2>/dev/null
  sleep 1

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  🎮  FiberQuest Launcher"
  echo "║  Game:  $game_id"
  echo "║  ROM:   $(basename "$rom_resolved")"
  echo "║  Core:  $core_so"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""
  echo "▶ Launching RetroArch..."

  export DISPLAY="$DISPLAY_ENV"
  export XAUTHORITY="$XAUTH"

  flatpak run org.libretro.RetroArch -L "$core_path" "$rom_resolved" > "$LOG" 2>&1 &
  local RA_PID=$!
  echo "  PID: $RA_PID"

  echo "  Waiting for RetroArch UDP..."
  local attempts=0
  while [ $attempts -lt 20 ]; do
    sleep 2
    attempts=$((attempts+1))
    if python3 -c "
import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.settimeout(1.0)
s.sendto(b'GET_STATUS',('localhost',55355))
try:
    d,_=s.recvfrom(1024)
    sys.exit(0)
except: sys.exit(1)
" 2>/dev/null; then
      echo "  ✅ RetroArch ready"
      break
    fi
    if ! kill -0 $RA_PID 2>/dev/null; then
      echo "  ❌ RetroArch crashed. Last log:"
      tail -20 "$LOG"
      exit 1
    fi
    echo "  ... $attempts/20"
  done

  echo ""
  echo "▶ Starting RAM poller on Pi..."
  if ssh -o ConnectTimeout=5 "$PI_HOST" "
    nohup python3 $POLLER_SCRIPT \
      --game $game_id \
      --games-dir /home/phill/.openclaw/workspace/fiberquest/games \
      --host 192.168.68.88 \
      > /tmp/ram-poller-${game_id}.log 2>&1 &
    echo \"RAM poller started: \$!\"
  " 2>/dev/null; then
    echo "  ✅ Poller running on Pi"
  else
    echo "  ⚠️  Pi unreachable — to start poller manually:"
    echo "     ssh pi 'python3 $POLLER_SCRIPT --game $game_id --host 192.168.68.88 &'"
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  RetroArch PID:  $RA_PID"
  echo "  Poller log:     ssh $PI_HOST 'tail -f /tmp/ram-poller-${game_id}.log'"
  echo "  RetroArch log:  tail -f $LOG"
  echo ""
  echo "  Stop all:       pkill -f retroarch; ssh $PI_HOST 'pkill -f ram-logger'"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
if [ -z "$1" ]; then
  list_games
  echo -n "Enter game ID (or q to quit): "
  read -r choice
  [ "$choice" = "q" ] && exit 0
  launch_game "$choice"
else
  case "$1" in
    list|ls) list_games ;;
    *) launch_game "$1" ;;
  esac
fi
