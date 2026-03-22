# Payment Flow Verification Checklist

## Code Integration ✅

- [x] FiberClient imports in tournament-manager.js
- [x] FiberClient has all required methods:
  - [x] getNodeInfo() - health check
  - [x] newInvoice() - create entry invoices
  - [x] sendPayment() - send payouts
  - [x] listChannels() - check channel balance
  - [x] listPayments() - transaction history
- [x] TournamentManager instantiates FiberClient
- [x] Entry fee flow: tournament.create() → newInvoice() → listens for payment
- [x] Payout flow: tournament ends → sendPayment(payoutInvoice)

## Configuration ✅

- [x] FiberQuest Pi RPC at 192.168.68.84:8227
- [x] N100 RPC at 192.168.68.91:8226 (SSH tunnel to 127.0.0.1:8226)
- [x] Both nodes on TESTNET (not mainnet)
- [x] Channel between N100 and FiberQuest Pi: OPEN
- [x] Both nodes funded (100,000 CKB via testnet faucet)

## Ready to Test

### What should happen:
1. Tournament created → entry invoice generated via newInvoice()
2. Player receives invoice → scans QR or copies text
3. Player calls sendPayment(invoice) → payment succeeds in 1-2 seconds
4. Channel balances update automatically
5. Tournament runs
6. Winner determined from RAM engine scoring
7. Agent sends payout via sendPayment(winnerInvoice)
8. Payment visible in listPayments() on both nodes

### Test commands ready:
- `node scripts/test-rpc.js` - connectivity check
- `E2E_PAYMENT_TEST.md` - step-by-step flow
- TournamentManager already integrates all payment logic

---

**Status: Payment infrastructure is COMPLETE and TESTABLE**

When ROMs are in place → can run full game + payment test
