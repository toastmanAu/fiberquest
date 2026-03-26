#!/usr/bin/env node
/**
 * Test v0.3.0 chain operations — no UI needed.
 * Creates tournament cell, intent cell, scans, batch-registers.
 *
 * Usage: node scripts/test-v03-chain.js
 * Requires: CKB_PRIVATE_KEY env var (agent wallet)
 */

'use strict';

const { ChainStore, STATE } = require('../src/chain-store');
const { AgentWallet } = require('../src/agent-wallet');
const { BlockTracker } = require('../src/block-tracker');

const RPC_URL = process.env.CKB_RPC_URL || 'https://testnet.ckbapp.dev/';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  FiberQuest v0.3.0 Chain Operations Test  ');
  console.log('═══════════════════════════════════════════\n');

  // 1. Init wallet + chain store + block tracker
  console.log('1. Initialising...');
  const wallet = new AgentWallet({ rpcUrl: RPC_URL });
  const cs = new ChainStore({ rpcUrl: RPC_URL, wallet });
  const bt = new BlockTracker({ rpcUrl: RPC_URL });
  await bt.start();

  console.log(`   Wallet:    ${wallet.address}`);
  console.log(`   Balance:   ${await wallet.getBalance()} CKB`);
  console.log(`   Tip block: ${bt.tipHeader?.number}`);
  console.log(`   Avg block: ${(bt.avgBlockTime / 1000).toFixed(1)}s\n`);

  // 2. Create tournament cell
  console.log('2. Creating tournament cell (OPEN)...');
  const tournamentId = `fq_test_${Date.now()}`;
  const tip = bt.tipHeader?.number || 0;

  const tcData = {
    id: tournamentId,
    gameId: 'mortal-kombat-snes',
    modeId: 'single_fight',
    entryFee: 10,
    currency: 'Fibt',
    playerCount: 2,
    registeredPlayers: 0,
    tournamentMode: 'distributed',
    organizerAddress: wallet.address,
    entryCutoffBlock: tip + 50,
    startBlock: tip + 80,
    endBlock: tip + 180,
    durationBlocks: 100,
    startMode: 'block',
    romHash: 'DEF42945',
    approvedAgentHashes: [],
    players: [],
    fiberPeerId: 'QmTest123',
  };

  try {
    const { txHash, outPoint } = await cs.createTournamentCell(tcData);
    console.log(`   TX:       ${txHash}`);
    console.log(`   OutPoint: ${outPoint.txHash}:${outPoint.index}`);
    console.log(`   Cutoff:   block ${tcData.entryCutoffBlock}`);
    console.log(`   Start:    block ${tcData.startBlock}`);
    console.log(`   End:      block ${tcData.endBlock}\n`);

    // 3. Wait for confirmation then scan
    console.log('3. Waiting for chain confirmation (~15s)...');
    await sleep(15000);

    console.log('   Scanning for tournament...');
    const tournaments = await cs.scanTournaments(tournamentId);
    console.log(`   Found: ${tournaments.length} tournament(s)`);
    if (tournaments.length > 0) {
      const tc = tournaments[0];
      console.log(`   State:    ${tc.state}`);
      console.log(`   Players:  ${tc.registeredPlayers}/${tc.playerCount}`);
      console.log(`   Game:     ${tc.gameId}`);
      console.log(`   ROM hash: ${tc.romHash}\n`);

      // 4. Create intent cell (simulating a PA)
      console.log('4. Creating intent cell (simulating PA join)...');
      const intentResult = await cs.createIntentCell(wallet, tournamentId, {
        playerAddress: wallet.address,
        fiberPeerId: 'QmFakePA123',
        agentCodeHash: 'sha256:test_hash_abc123',
        createdAtBlock: bt.tipHeader?.number,
      });
      console.log(`   Intent TX: ${intentResult.txHash}\n`);

      // 5. Wait then scan for intents
      console.log('5. Waiting for intent confirmation (~15s)...');
      await sleep(15000);

      console.log('   Scanning for intent cells...');
      const intents = await cs.scanIntentCells(tournamentId);
      console.log(`   Found: ${intents.length} intent(s)`);
      for (const intent of intents) {
        console.log(`   - Player: ${intent.playerAddress?.slice(0, 30)}...`);
        console.log(`     Fiber:  ${intent.fiberPeerId}`);
        console.log(`     Hash:   ${intent.agentCodeHash}`);
      }
      console.log('');

      // 6. Batch-register the intent
      if (intents.length > 0) {
        console.log('6. Batch-registering players on TC...');
        // Re-scan TC for fresh outpoint
        const freshTC = await cs.scanTournaments(tournamentId);
        if (freshTC.length > 0) {
          const result = await cs.batchRegisterPlayers(freshTC[0].outPoint, freshTC[0], intents);
          console.log(`   Registration TX: ${result.txHash}`);

          // 7. Verify registration
          console.log('\n7. Waiting for registration confirmation (~15s)...');
          await sleep(15000);

          const updated = await cs.scanTournaments(tournamentId);
          if (updated.length > 0) {
            console.log(`   Players:  ${updated[0].registeredPlayers}/${updated[0].playerCount}`);
            for (const p of updated[0].players || []) {
              console.log(`   - ${p.id}: ${p.address?.slice(0, 30)}... (channel: ${p.channelFunded ? 'funded' : 'pending'})`);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`   ERROR: ${e.message}`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Test complete');
  console.log('═══════════════════════════════════════════');

  bt.stop();
  process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error(e); process.exit(1); });
