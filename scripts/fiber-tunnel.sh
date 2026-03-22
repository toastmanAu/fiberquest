#!/bin/bash
# FiberQuest — SSH Tunnel Management
# Usage:
#   ./fiber-tunnel.sh n100      # Tunnel to N100 (localhost:18226)
#   ./fiber-tunnel.sh ckbnode   # Tunnel to ckbnode (localhost:18227)
#   ./fiber-tunnel.sh status    # Check active tunnels
#   ./fiber-tunnel.sh kill      # Kill all tunnels

set -e

NODE=${1:-"help"}

case "$NODE" in
  n100)
    echo "🔗 Setting up tunnel to N100..."
    ssh -f -N -L 18226:127.0.0.1:8226 phill@192.168.68.79
    sleep 2
    if nc -z 127.0.0.1 18226 &>/dev/null; then
      echo "✅ N100 tunnel ready at localhost:18226"
      echo "   Test: node scripts/test-rpc.js http://localhost:18226"
    else
      echo "❌ Tunnel setup failed"
      exit 1
    fi
    ;;

  ckbnode)
    echo "🔗 Setting up tunnel to ckbnode..."
    ssh -f -N -L 18227:127.0.0.1:8227 orangepi@192.168.68.87
    sleep 2
    if nc -z 127.0.0.1 18227 &>/dev/null; then
      echo "✅ ckbnode tunnel ready at localhost:18227"
      echo "   Test: node scripts/test-rpc.js http://localhost:18227"
    else
      echo "❌ Tunnel setup failed"
      exit 1
    fi
    ;;

  status)
    echo "📊 Active SSH Tunnels:"
    ps aux | grep -E "ssh.*-L.*127.0.0.1:(18226|18227)" | grep -v grep || echo "  (none)"
    echo ""
    echo "🔍 Listening ports:"
    (netstat -tlnp 2>/dev/null | grep -E ":(18226|18227)" || echo "  (none)") | grep -v grep || true
    ;;

  kill)
    echo "🔪 Killing all FiberQuest SSH tunnels..."
    pkill -f "ssh.*-L.*127.0.0.1:(18226|18227)" || echo "  (none running)"
    sleep 1
    ps aux | grep -E "ssh.*-L.*127.0.0.1:(18226|18227)" | grep -v grep || echo "✅ All tunnels closed"
    ;;

  *)
    echo "FiberQuest SSH Tunnel Manager"
    echo ""
    echo "Usage:"
    echo "  $0 n100       Set up tunnel to N100 (→ localhost:18226)"
    echo "  $0 ckbnode    Set up tunnel to ckbnode (→ localhost:18227)"
    echo "  $0 status     Check active tunnels"
    echo "  $0 kill       Close all tunnels"
    exit 1
    ;;
esac
