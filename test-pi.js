const FiberClient = require('./src/fiber-client.js');

(async () => {
  const client = new FiberClient('http://192.168.68.84:8227', { debug: false });

  try {
    const nodeInfo = await client.getNodeInfo();
    console.log('✅ FiberQuest Pi is running');
    console.log(`   Pubkey: ${nodeInfo.node_pubkey.slice(0, 16)}...`);
  } catch (err) {
    console.error('❌ FiberQuest Pi offline:', err.message);
  }
})();
