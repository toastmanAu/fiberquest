# FiberQuest End-to-End Payment Flow Test

**Status:** Ready to test on testnet
**Date:** 2026-03-22
**Network:** CKB Testnet
**Channels:** N100 ↔ FiberQuest Pi (CHANNEL_READY)

---

## Test Scenario

Simulate a complete tournament flow:
1. Player opens invoice (entry fee)
2. Agent receives payment
3. Tournament runs
4. Agent pays winner

---

## Prerequisites

✅ **N100 Fiber Node** (testnet)
- RPC: `http://127.0.0.1:8226` (or `http://192.168.68.91:8226` via SSH tunnel)
- Status: Funded, CHANNEL_READY with FiberQuest Pi
- Balance: ~10,000 CKB local

✅ **FiberQuest Pi Fiber Node** (testnet)
- RPC: `http://192.168.68.84:8227`
- Status: Connected to N100
- Biscuit auth required
- Config: `/home/phill/.fiber-mainnet/data/config.yml`

✅ **Node.js + npm**
```bash
cd /home/phill/.openclaw/workspace/fiberquest
npm install  # Already done, but verify
```

---

## Step 1: Verify Connectivity

### From FiberQuest Pi

```bash
# Test N100 node (via tunnel or local)
node scripts/test-rpc.js http://127.0.0.1:8226

# Expected output:
# ✅ node_info
# ✅ list_channels (should show 1 channel with N100)
# ✅ list_peers
# ✅ list_payments
# ✅ new_invoice (1 CKB test)
```

### From N100

```bash
node scripts/test-rpc.js http://127.0.0.1:8226

# Verify channel visible from both sides
```

---

## Step 2: Create Entry Invoice (Agent Side)

### Scenario: Agent (N100) creates invoice for player entry fee

```javascript
// Quick test: node -e "..."
const FiberClient = require('./src/fiber-client.js');
const client = new FiberClient('http://127.0.0.1:8226', { debug: true });

(async () => {
  // Create invoice for 100 CKB entry fee (for testing)
  const invoice = await client.newInvoice(
    FiberClient.ckbToShannon(100),  // 100 CKB in shannons
    'FiberQuest Tournament Entry - Test Match',
    { expiry: 3600 }  // 1 hour
  );

  console.log('Entry Invoice:', invoice);
  console.log('Share with player: Copy the invoice string above');
})();
```

**Expected output:**
```
Entry Invoice: lnfb1001pn...  (BOLT11 format)
```

---

## Step 3: Pay Entry Fee (Player Side)

### Scenario: Player (FiberQuest Pi) pays the entry invoice

```javascript
const FiberClient = require('./src/fiber-client.js');
const client = new FiberClient('http://192.168.68.84:8227', { debug: true });

(async () => {
  // Invoice from Step 2
  const invoice = 'lnfb1001pn...';  // From agent

  const result = await client.sendPayment(invoice);
  console.log('Payment result:', result);
})();
```

**Expected output:**
```
Payment result: {
  payment_id: '0x...',
  preimage: '0x...',
  amount: '0x2540BE400',  // 100 CKB in shannons
  status: 'succeeded'
}
```

---

## Step 4: Verify Channels After Payment

### Check channel balances changed

```javascript
const client = new FiberClient('http://127.0.0.1:8226');

(async () => {
  const channels = await client.listChannels();

  channels.channels.forEach(ch => {
    const localCkb = FiberClient.shannonToCkb(ch.local_balance);
    const remoteCkb = FiberClient.shannonToCkb(ch.remote_balance);
    console.log(`
      Channel: ${ch.channel_id.slice(0, 16)}...
      Local (Agent):  ${localCkb.toFixed(4)} CKB
      Remote (Player): ${remoteCkb.toFixed(4)} CKB
      State: ${ch.state.state_name}
    `);
  });
})();
```

**Expected output:**
```
Agent (N100) should have:
  local_balance decreased by ~100 CKB (sent to player's side)
  remote_balance increased by ~100 CKB (received from player)

Player (FiberQuest Pi) should have:
  local_balance increased by ~100 CKB (received from agent)
  remote_balance decreased by ~100 CKB (sent to agent)
```

---

## Step 5: List Payments (Verify History)

### Check payment history on both sides

```javascript
const client = new FiberClient('http://127.0.0.1:8226');

(async () => {
  const payments = await client.listPayments({ limit: 10 });

  payments.payments.forEach(p => {
    console.log(`
      Amount: ${FiberClient.shannonToCkb(p.amount).toFixed(4)} CKB
      Description: ${p.description}
      Status: ${p.status}
      Direction: ${p.direction}  // outbound (sent) or inbound (received)
    `);
  });
})();
```

**Expected output:**
```
Payment from entry fee visible in history on both nodes
Direction should be: inbound on Agent side, outbound on Player side
```

---

## Step 6: Tournament Manager Integration Test

### Full tournament flow with real Fiber payments

```javascript
const TournamentManager = require('./src/tournament-manager.js');

(async () => {
  const tm = new TournamentManager({
    fiberRpc: 'http://127.0.0.1:8226',
    gameId: 'super-mario-bros'
  });

  // Create tournament
  const tournament = await tm.create({
    gameId: 'super-mario-bros',
    mode: 'time_limit',
    duration: 300,  // 5 minutes
    entryFee: 50,   // 50 CKB
    maxPlayers: 2
  });

  console.log('Tournament created:', tournament.id);

  // Listen for events
  tournament.on('invoice', ({ playerId, invoice }) => {
    console.log(`Player ${playerId} invoice: ${invoice}`);
  });

  tournament.on('started', () => {
    console.log('Tournament started! RAM engine polling...');
  });

  tournament.on('complete', ({ winner, payoutTx }) => {
    console.log(`Winner: ${winner}`);
    console.log(`Payout TX: ${payoutTx}`);
  });

  // Start tournament
  await tournament.start();
})();
```

---

## Critical Checks

| Check | Status | How to Verify |
|-------|--------|---------------|
| Channels are CHANNEL_READY | Should be ✅ | `listChannels()` shows both peers, state=CHANNEL_READY |
| Invoice creation works | Should be ✅ | Step 2: `newInvoice()` returns valid BOLT11 invoice |
| Payment sends successfully | Should be ✅ | Step 3: `sendPayment()` returns status=succeeded |
| Channel balances shift | Should be ✅ | Step 4: local/remote balance changes match payment |
| Payments appear in history | Should be ✅ | Step 5: `listPayments()` includes recent transactions |
| Tournament manager integrates | Should be ✅ | Step 6: TournamentManager creates and emits events |

---

## Potential Issues & Fixes

### Issue 1: "No path found" / Payment timeout
**Cause:** Trampoline routing not fully functional on testnet
**Fix:** Ensure direct channel exists (already open: N100 ↔ FiberQuest Pi)
**Workaround:** Keep payments on direct channels only

### Issue 2: "Invalid currency" error
**Cause:** Invoice created with wrong currency code
**Fix:** Use `'Fibb'` for testnet (see CLAUDE.md)
**Code:** `await client.newInvoice(amount, desc, { currency: 'Fibb' })`

### Issue 3: Invoice expires too fast
**Cause:** Default expiry too short
**Fix:** Set `expiry` to longer duration
**Code:** `await client.newInvoice(amount, desc, { expiry: 3600 })`

### Issue 4: Channel state shows OFFLINE
**Cause:** Peer disconnected or restarted
**Fix:** Restart both nodes:
```bash
# N100
pkill -f fnn
rm ~/.fiber-testnet/store/LOCK  # if stuck

# FiberQuest Pi
systemctl --user restart fiber  # or manual start
```

---

## Success Criteria

✅ Entry invoices can be created
✅ Payments send and succeed
✅ Channel balances update correctly
✅ Payment history shows transactions
✅ TournamentManager events fire
✅ Payout invoices work (reverse flow)

---

## Next Steps

1. Run Steps 1-5 above to verify basic Fiber connectivity
2. Test tournament-manager integration (Step 6)
3. Run RetroArch UDP polling test with real game
4. Full end-to-end demo (game → scoring → payment → payout)

**When ready:** All of the above should complete cleanly for hackathon submission.

