# FiberQuest Fiber Nodes Reference

## Network Configuration

### N100 (Primary Development/Testing Node)
- **IP:** 192.168.68.79
- **Network:** CKB Testnet
- **RPC Port:** 8226 (localhost-only)
- **SSH User:** phill
- **SSH Key:** ~/.ssh/id_ed25519
- **SSH Tunnel:** `ssh -L 18226:127.0.0.1:8226 phill@192.168.68.79`
- **Status:** ✅ Testnet ready
- **Purpose:** Entry point for all hackathon testing & E2E payment tests

### ckbnode (FiberQuest Pi)
- **IP:** 192.168.68.87
- **Network:** CKB Mainnet
- **RPC Port:** 8227 (localhost-only)
- **SSH User:** orangepi
- **SSH Key:** ~/.ssh/id_rsa_pi5
- **SSH Tunnel:** `ssh -L 18227:127.0.0.1:8227 orangepi@192.168.68.87`
- **Status:** ✅ Mainnet (post-hackathon)
- **Purpose:** Production Fiber network (Phase 2+)

---

## Testing Workflow

### For Hackathon (March 25)
**Use N100 (testnet only)**
```bash
# Set up N100 tunnel
./scripts/fiber-tunnel.sh n100

# Verify N100 testnet connection
./scripts/fiber-check.sh n100

# Run E2E payment tests against testnet
node test-step1.js  # Should connect to N100 testnet
node test-step2.js  # Create testnet invoices
node test-step3.js  # Send testnet payments
```

### After Hackathon (Phase 2)
**Switch to ckbnode (mainnet)**
```bash
# Set up ckbnode tunnel
./scripts/fiber-tunnel.sh ckbnode

# Update Fiber RPC URL in config
FIBER_RPC=http://localhost:18227 npm start
```

---

## E2E Payment Test Configuration

File: `E2E_PAYMENT_TEST.md`

**Current configuration assumes N100 testnet:**
- Agent: N100 at http://127.0.0.1:8226 (or via tunnel: http://localhost:18226)
- Player: FiberQuest Pi testnet instance
- Channel: N100 ↔ FiberQuest Pi (CHANNEL_READY on testnet)

Update if needed:
```javascript
// Verify these RPC endpoints match N100 testnet:
const agentRpc = 'http://localhost:18226';  // N100 testnet
const playerRpc = 'http://localhost:18227'; // Only if also testnet
```

---

## Next Steps

1. **Verify N100 is online and testnet:**
   ```bash
   ssh phill@192.168.68.79 "fnn --version"  # Should show fnn version
   ssh phill@192.168.68.79 "curl http://localhost:8226 -X POST ..."  # Test RPC
   ```

2. **Run connectivity test:**
   ```bash
   ./scripts/fiber-tunnel.sh n100
   ./scripts/fiber-check.sh n100
   ```

3. **Execute E2E payment tests:**
   - Follow steps in `E2E_PAYMENT_TEST.md`
   - All against N100 testnet RPC

---

**Mainnet (ckbnode):** Defer to Phase 2 post-hackathon
**Testnet (N100):** Priority for hackathon demo (March 25)

