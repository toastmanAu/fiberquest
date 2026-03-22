const FiberClient = require('./src/fiber-client.js');

(async () => {
  console.log('Testing SSH tunnel to ckbnode (Pi5)...');
  const client = new FiberClient('http://127.0.0.1:18227', { debug: false });

  try {
    const nodeInfo = await client.getNodeInfo();
    console.log('✅ ckbnode is accessible via tunnel');
    console.log(`   Pubkey: ${nodeInfo.node_pubkey.slice(0, 16)}...`);
    
    const channels = await client.listChannels();
    console.log(`✅ ${channels.channels.length} channel(s) open`);
    channels.channels.forEach(ch => {
      console.log(`   ${ch.channel_id.slice(0, 16)}... → ${ch.state.state_name}`);
    });
  } catch (err) {
    console.error('❌ Failed:', err.message);
  }
})();
