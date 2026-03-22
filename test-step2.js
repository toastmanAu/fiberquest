const FiberClient = require('./src/fiber-client.js');

(async () => {
  console.log('=== E2E PAYMENT TEST - Step 2: Create Entry Invoice ===\n');

  const client = new FiberClient('http://localhost:18226', { debug: false });

  try {
    console.log('Creating entry fee invoice on N100 testnet agent...\n');
    
    const result = await client.newInvoice(
      FiberClient.ckbToShannon(100),  // 100 CKB in shannons
      'FiberQuest Tournament Entry - Testnet',
      { expiry: 3600, currency: 'Fibt' }  // Fibt for testnet
    );

    console.log('✅ Invoice created successfully');
    console.log(`   Address: ${result.invoice_address.slice(0, 50)}...`);
    console.log(`   Amount: 100 CKB`);
    console.log(`   Currency: Fibt (testnet)`);
    console.log(`   Status: Ready for payment\n`);
    
    console.log('Full invoice:\n', result.invoice_address);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
