#!/usr/bin/env node
// Minimal Smart Account test — matches SDK README exactly.
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

(async () => {
  const cdp = new CdpClient();

  console.log('[1] Creating EOA owner account...');
  const owner = await cdp.evm.createAccount();
  console.log(`  Owner: ${owner.address}`);

  console.log('[2] Creating Smart Account...');
  const smart = await cdp.evm.createSmartAccount({ owner });
  console.log(`  Smart Account: ${smart.address}`);

  console.log('[3] Requesting faucet ETH for Smart Account...');
  try {
    const faucet = await cdp.evm.requestFaucet({
      address: smart.address,
      network: 'base-sepolia',
      token: 'eth',
    });
    console.log(`  Faucet TX: ${faucet.transactionHash}`);
  } catch (err) {
    console.warn(`  Faucet failed: ${err.message}`);
  }

  // Wait for faucet
  await new Promise(r => setTimeout(r, 5000));

  console.log('[4] Sending a simple UserOperation (0 ETH to zero address)...');
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
    console.log(`  ✅ Success! userOpHash: ${result.userOpHash}`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    console.error(`  Full error:`, JSON.stringify(err, null, 2));
  }

  console.log('\n[5] Trying with getOrCreateSmartAccount (named)...');
  const owner2 = await cdp.evm.getOrCreateAccount({ name: 'test-named-owner' });
  const smart2 = await cdp.evm.getOrCreateSmartAccount({ name: 'test-named-smart', owner: owner2 });
  console.log(`  Smart Account 2: ${smart2.address}`);

  try {
    const result2 = await cdp.evm.sendUserOperation({
      smartAccount: smart2,
      network: 'base-sepolia',
      calls: [{
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        data: '0x',
      }],
    });
    console.log(`  ✅ Success! userOpHash: ${result2.userOpHash}`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    console.error(`  Full error:`, JSON.stringify(err, null, 2));
  }
})().catch(console.error);
