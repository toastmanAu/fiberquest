# N100 Testnet Fiber Node - Setup & Testing Guide

**Priority:** 🔴 HIGH (Needed for hackathon E2E payment tests)
**Deadline:** March 25, 2026 (3 days)
**Node:** N100 (192.168.68.79) — CKB Testnet

---

## Quick Start (When N100 is Online)

```bash
# 1. SSH to N100
ssh phill@192.168.68.79

# 2. Verify Fiber node is running
ps aux | grep fnn
# Should show: /path/to/fnn (running)

# 3. Check testnet RPC is responding
curl http://localhost:8226 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"node_info","params":[],"id":1}'
# Should return: {"result":{"node_pubkey":"..."}}

# 4. Return to driveThree and set up tunnel
exit

./scripts/fiber-tunnel.sh n100
# Should print: ✅ N100 tunnel ready at localhost:18226
```

---

## Health Checks

### Check 1: SSH Access
```bash
ssh phill@192.168.68.79 "echo Connected to $(hostname)"
# Expected: Connected to phill-NucBox-K8-Plus
```

### Check 2: Fiber Node Process
```bash
ssh phill@192.168.68.79 "ps aux | grep fnn | grep -v grep"
# Expected: phill ... /path/to/fnn (with relevant options)
```

### Check 3: RPC Port Listening
```bash
ssh phill@192.168.68.79 "netstat -tlnp | grep 8226"
# Expected: tcp ... 127.0.0.1:8226 LISTEN
```

### Check 4: RPC Responsiveness
```bash
ssh phill@192.168.68.79 "curl -s http://localhost:8226 -X POST \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"node_info\",\"params\":[],\"id\":1}' | grep node_pubkey"
# Expected: "node_pubkey":"0x..."
```

### Check 5: Testnet Network
```bash
ssh phill@192.168.68.79 "curl -s http://localhost:8226 -X POST \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_blockchain_info\",\"params\":[],\"id\":1}' | grep -o '\"chain\":\"[^\"]*\"'"
# Expected: "chain":"testnet"
```

---

## Startup Checklist

### On N100 (phill@192.168.68.79)

- [ ] Fiber node process (`fnn`) is running
- [ ] RPC port 8226 is listening on 127.0.0.1
- [ ] `node_info` RPC responds with node pubkey
- [ ] Network is testnet (not mainnet)
- [ ] Channel to FiberQuest Pi shows CHANNEL_READY

```bash
# Full startup check script
ssh phill@192.168.68.79 << 'SCRIPT'
echo "=== N100 Testnet Fiber Node Startup Check ==="
echo ""

echo "1. Process status:"
if ps aux | grep -q "[f]nn"; then
  echo "   ✅ fnn is running"
else
  echo "   ❌ fnn is NOT running"
  exit 1
fi

echo "2. RPC port 8226:"
if netstat -tlnp 2>/dev/null | grep -q 8226; then
  echo "   ✅ Port 8226 listening"
else
  echo "   ❌ Port 8226 not listening"
  exit 1
fi

echo "3. RPC connectivity:"
if curl -s http://localhost:8226 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"node_info","params":[],"id":1}' | grep -q node_pubkey; then
  echo "   ✅ RPC responding"
else
  echo "   ❌ RPC not responding"
  exit 1
fi

echo "4. Network (should be testnet):"
CHAIN=$(curl -s http://localhost:8226 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"get_blockchain_info","params":[],"id":1}' | grep -o '"chain":"[^"]*"')
echo "   $CHAIN"

echo "5. Channels:"
curl -s http://localhost:8226 -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"list_channels","params":[{}],"id":1}' | grep -o '"channel_id":"[^"]*"' || echo "   (no channels)"

echo ""
echo "✅ All checks passed!"
SCRIPT
```

---

## From DriveThree (Our Machine)

### Test Tunnel Setup
```bash
cd /tmp/fiberquest

# 1. Create SSH tunnel to N100
./scripts/fiber-tunnel.sh n100
# Should print: ✅ N100 tunnel ready at localhost:18226

# 2. Verify tunnel is working
./scripts/fiber-check.sh n100
# Should show: ✅ N100 is responding
```

### Test with FiberClient
```bash
# Quick test
node -e "
const FiberClient = require('./src/fiber-client.js');
const client = new FiberClient('http://localhost:18226');

(async () => {
  try {
    const info = await client.getNodeInfo();
    console.log('✅ Connected to N100 testnet');
    console.log('   Pubkey:', info.node_pubkey.slice(0, 16) + '...');

    const channels = await client.listChannels();
    console.log('   Channels:', channels.channels.length);
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
  }
})();
"
```

---

## Running E2E Payment Tests

Once N100 tunnel is established:

```bash
# Step 1: Verify connectivity
node test-step1.js
# Expected: ✅ node_info, ✅ list_channels, ✅ All connectivity tests passed!

# Step 2: Create entry invoice (agent side)
node -e "
const FiberClient = require('./src/fiber-client.js');
const client = new FiberClient('http://localhost:18226', { debug: true });

(async () => {
  const invoice = await client.newInvoice(
    FiberClient.ckbToShannon(100),
    'Testnet Tournament Entry Fee',
    { expiry: 3600 }
  );
  console.log('Entry Invoice:', invoice);
})();
"

# Step 3: Send payment (if FiberQuest Pi is also on testnet)
# ... continue with steps from E2E_PAYMENT_TEST.md
```

---

## Troubleshooting N100

### Issue: N100 offline / unreachable
```bash
# Check network connectivity
ping -c 3 192.168.68.79

# Try SSH with verbose output
ssh -vvv phill@192.168.68.79 "echo test"

# Check your network routing
ip route show | grep 192.168
```

### Issue: RPC port not listening
```bash
# SSH to N100 and check
ssh phill@192.168.68.79 "netstat -tlnp | grep -E '8226|fnn'"

# Start fnn if not running
ssh phill@192.168.68.79 "ps aux | grep [f]nn || fnn &"
```

### Issue: Testnet vs Mainnet confusion
```bash
# Check which network N100 is on
ssh phill@192.168.68.79 "curl -s http://localhost:8226 -X POST \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"get_blockchain_info\",\"params\":[],\"id\":1}' | grep -o '\"chain\":\"[^\"]*\"'"

# Expected: "chain":"testnet"
# If shows mainnet, configuration needs update
```

### Issue: Tunnel connection timeout
```bash
# Make sure N100 is online first
ping -c 1 192.168.68.79

# Kill any stuck tunnels
./scripts/fiber-tunnel.sh kill

# Try again
./scripts/fiber-tunnel.sh n100
```

---

## Success Criteria

✅ **N100 Testnet Ready When:**
1. SSH connection works: `ssh phill@192.168.68.79 "echo OK"`
2. Fiber node running: `fnn` process visible
3. RPC responds: `node_info` returns node pubkey
4. Network confirmed testnet: `get_blockchain_info` shows `"chain":"testnet"`
5. Tunnel established: `localhost:18226` accessible from driveThree
6. FiberClient connects: `new FiberClient('http://localhost:18226')` works

---

## Timeline

**March 22 (Today):** ✅ Setup guide created, tunnels configured, scripts ready
**March 23-24:** Wait for N100 to come online, run tests
**March 25:** Live hackathon demo using N100 testnet

---

## Commands Quick Reference

```bash
# SSH to N100
ssh phill@192.168.68.79

# Set up tunnel (from driveThree)
./scripts/fiber-tunnel.sh n100

# Check status
./scripts/fiber-check.sh n100

# Kill tunnel
./scripts/fiber-tunnel.sh kill

# Full startup check (on N100)
ssh phill@192.168.68.79 << 'EOF'
ps aux | grep fnn && netstat -tlnp | grep 8226 && echo "✅ Ready"
EOF
```

---

**Last Updated:** 2026-03-22
**Status:** ⏳ Waiting for N100 to come online

