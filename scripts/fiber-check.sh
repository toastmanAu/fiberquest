#!/bin/bash
# FiberQuest — Fiber Node Health Check
# Usage: ./fiber-check.sh [node|both]

NODE=${1:-"both"}

echo "🏥 FiberQuest Fiber Node Health Check"
echo ""

check_node() {
  local name=$1
  local url=$2
  
  echo "Checking $name at $url..."
  if curl -s "$url" -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"node_info","params":[],"id":1}' 2>/dev/null | grep -q node_pubkey; then
    echo "  ✅ $name is responding"
    
    # Get version
    local version=$(curl -s "$url" -X POST \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"node_info","params":[],"id":1}' 2>/dev/null | grep -o '"version":"[^"]*"' | head -1)
    echo "     $version"
    
    # Check channels
    local channels=$(curl -s "$url" -X POST \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"list_channels","params":[{}],"id":1}' 2>/dev/null | grep -o '"channels":\[' | wc -l)
    if [ "$channels" -gt 0 ]; then
      echo "     Channels found ✅"
    else
      echo "     No channels (may be normal)"
    fi
  else
    echo "  ❌ $name is NOT responding"
    return 1
  fi
  echo ""
}

case "$NODE" in
  n100)
    check_node "N100" "http://localhost:18226"
    ;;
  ckbnode)
    check_node "ckbnode" "http://localhost:18227"
    ;;
  both)
    check_node "N100" "http://localhost:18226" || true
    check_node "ckbnode" "http://localhost:18227" || true
    ;;
  *)
    echo "Usage: $0 [n100|ckbnode|both]"
    exit 1
    ;;
esac
