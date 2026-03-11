#!/usr/bin/env node
/**
 * Live RPC test against running Fiber node
 * Run: node scripts/test-rpc.js [rpc-url]
 * Default URL: http://127.0.0.1:8227
 */

'use strict';

const FiberClient = require('../src/fiber-client');

const RPC_URL = process.argv[2] || 'http://127.0.0.1:8227';

async function run() {
  console.log(`\n🔌 FiberQuest RPC Test`);
  console.log(`   Target: ${RPC_URL}\n`);

  const client = new FiberClient(RPC_URL, { debug: false });

  // 1. Health check
  process.stdout.write('  node_info ... ');
  const info = await client.getNodeInfo();
  console.log('✅');
  console.log(`    node_id:  ${info.node_id || info.node_name || JSON.stringify(info).slice(0,80)}`);
  if (info.addresses) console.log(`    addresses: ${info.addresses.join(', ')}`);

  // 2. List channels
  process.stdout.write('  list_channels ... ');
  const chans = await client.listChannels();
  const list = chans.channels || chans || [];
  console.log(`✅ (${list.length} channels)`);
  list.forEach(c => {
    const localCkb = FiberClient.shannonToCkb(c.local_balance || '0x0').toFixed(4);
    const remoteCkb = FiberClient.shannonToCkb(c.remote_balance || '0x0').toFixed(4);
    console.log(`    ${c.channel_id?.slice(0,16)}... local:${localCkb} remote:${remoteCkb} state:${c.state?.state_name || c.status || '?'}`);
  });

  // 3. List peers
  process.stdout.write('  list_peers ... ');
  try {
    const peers = await client.listPeers();
    const peerList = peers.peers || peers || [];
    console.log(`✅ (${peerList.length} peers)`);
  } catch (e) {
    console.log(`⚠️  ${e.message}`);
  }

  // 4. List payments
  process.stdout.write('  list_payments ... ');
  try {
    const payments = await client.listPayments({ limit: 5 });
    const pmtList = payments.payments || payments || [];
    console.log(`✅ (${pmtList.length} recent payments)`);
  } catch (e) {
    console.log(`⚠️  ${e.message}`);
  }

  // 5. Test invoice creation (dry run — small amount)
  process.stdout.write('  new_invoice (1 CKB) ... ');
  try {
    const invoice = await client.newInvoice(
      FiberClient.ckbToShannon(1),
      'FiberQuest RPC test invoice',
      { expiry: 300 }
    );
    console.log('✅');
    console.log(`    invoice: ${(invoice.invoice_address || invoice).slice(0, 60)}...`);
  } catch (e) {
    console.log(`⚠️  ${e.message}`);
  }

  console.log('\n✅ RPC test complete\n');

  // Dump raw node info for schema documentation
  console.log('--- node_info schema ---');
  console.log(JSON.stringify(info, null, 2));
  if (list.length > 0) {
    console.log('\n--- channel schema (first channel) ---');
    console.log(JSON.stringify(list[0], null, 2));
  }
}

run().catch(err => {
  console.error(`\n❌ ${err.message}`);
  if (err.code) console.error(`   RPC error code: ${err.code}`);
  process.exit(1);
});
