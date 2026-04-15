#!/usr/bin/env node
// Diagnose Smart Account UserOp signature issue
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

(async () => {
  console.log('CDP_API_KEY_ID:', process.env.CDP_API_KEY_ID ? 'SET' : 'NOT SET');
  console.log('CDP_API_KEY_SECRET:', process.env.CDP_API_KEY_SECRET ? 'SET (' + process.env.CDP_API_KEY_SECRET.slice(0, 30) + '...)' : 'NOT SET');
  console.log('CDP_WALLET_SECRET:', process.env.CDP_WALLET_SECRET ? 'SET (' + process.env.CDP_WALLET_SECRET.slice(0, 30) + '...)' : 'NOT SET');
  console.log('CDP_PROJECT_ID:', process.env.CDP_PROJECT_ID || 'NOT SET');
  console.log('');

  const cdp = new CdpClient();

  // Test 1: Can we create accounts? (proves API key works)
  console.log('[1] Creating EOA account (tests API key)...');
  const owner = await cdp.evm.createAccount();
  console.log(`  ✅ Owner: ${owner.address}`);

  // Test 2: Can we create smart accounts? (proves wallet secret works for creation)
  console.log('[2] Creating Smart Account...');
  const smart = await cdp.evm.createSmartAccount({ owner });
  console.log(`  ✅ Smart: ${smart.address}`);
  console.log(`  Owners: ${JSON.stringify(smart.owners?.map(o => o.address || o))}`);

  // Test 3: Can we sign with the owner? (proves wallet secret works for signing)
  console.log('[3] Testing owner.sign()...');
  try {
    const testHash = '0x' + '00'.repeat(32);
    const sig = await owner.sign({ hash: testHash });
    console.log(`  ✅ Signature: ${sig.slice(0, 20)}...`);
  } catch (err) {
    console.log(`  ❌ Sign failed: ${err.message}`);
  }

  // Test 4: Try sendUserOperation with detailed error
  console.log('[4] Sending UserOperation...');
  try {
    const result = await cdp.evm.sendUserOperation({
      smartAccount: smart,
      network: 'base-sepolia',
      calls: [{
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        data: '0x',
      }],
    });
    console.log(`  ✅ SUCCESS! userOpHash: ${result.userOpHash}`);
  } catch (err) {
    console.log(`  ❌ Failed: ${err.errorMessage || err.message}`);
    if (err.correlationId) console.log(`  correlationId: ${err.correlationId}`);

    // Try to manually replicate what the SDK does
    console.log('\n[5] Manual debug — prepareUserOperation...');
    try {
      // Access the internal API client
      const prepResult = await cdp._apiClients.evm.prepareUserOperation(smart.address, {
        network: 'base-sepolia',
        calls: [{
          to: '0x0000000000000000000000000000000000000001',
          data: '0x',
          value: '0',
        }],
      });
      console.log(`  ✅ Prepared OK. userOpHash: ${prepResult.userOpHash}`);

      console.log('[6] Signing userOpHash with owner...');
      const signature = await owner.sign({ hash: prepResult.userOpHash });
      console.log(`  ✅ Signed: ${signature.slice(0, 20)}...`);

      console.log('[7] Broadcasting signed UserOp...');
      const broadcastResult = await cdp._apiClients.evm.sendUserOperation(
        smart.address,
        prepResult.userOpHash,
        { signature },
      );
      console.log(`  ✅ Broadcast OK! Status: ${broadcastResult.status}`);
    } catch (manualErr) {
      console.log(`  ❌ Manual step failed: ${manualErr.errorMessage || manualErr.message}`);
    }
  }
})().catch(err => {
  console.error('Fatal:', err.message);
});
