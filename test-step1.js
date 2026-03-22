const FiberClient = require('./src/fiber-client.js');

(async () => {
  console.log('=== E2E PAYMENT TEST - Step 1: Verify N100 Testnet Connectivity ===\n');

  const client = new FiberClient('http://localhost:18226', { debug: false });

  try {
    console.log('Testing N100 testnet node (agent side)...\n');
    
    const nodeInfo = await client.getNodeInfo();
    console.log('✅ node_info: ' + nodeInfo.node_id.slice(0, 16) + '...');

    const channels = await client.listChannels();
    console.log(`✅ list_channels: ${channels.channels.length} channel(s)`);
    channels.channels.forEach((ch, i) => {
      const localCkb = FiberClient.shannonToCkb(ch.local_balance);
      const remoteCkb = FiberClient.shannonToCkb(ch.remote_balance);
      console.log(`   [${i}] Channel: ${ch.channel_id.slice(0, 16)}...`);
      console.log(`       State: ${ch.state.state_name}`);
      console.log(`       Local (Agent): ${localCkb.toFixed(2)} CKB, Remote (Player): ${remoteCkb.toFixed(2)} CKB`);
    });

    const peers = await client.listPeers();
    console.log(`✅ list_peers: ${peers.peers.length} peer(s)`);

    const payments = await client.listPayments({ limit: 5 });
    console.log(`✅ list_payments: ${payments.payments.length} payment(s) in history`);

    console.log('\n✅ All connectivity tests passed!');
    console.log('\nN100 testnet is ready for E2E payment testing.\n');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
