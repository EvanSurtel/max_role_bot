#!/usr/bin/env node
// Test Smart Account with paymaster URL.
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

(async () => {
  const cdp = new CdpClient();

  console.log('[1] Creating EOA + Smart Account...');
  const owner = await cdp.evm.createAccount();
  const smart = await cdp.evm.createSmartAccount({ owner });
  console.log(`  Owner: ${owner.address}`);
  console.log(`  Smart: ${smart.address}`);

  // Try multiple paymaster URL patterns
  const apiKeyId = process.env.CDP_API_KEY_ID || '';
  const projectId = process.env.CDP_PROJECT_ID || '';

  const urls = [
    // Pattern 1: project ID based
    projectId ? `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${projectId}` : null,
    // Pattern 2: API key ID based
    apiKeyId ? `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${apiKeyId}` : null,
    // Pattern 3: no paymaster (let SDK handle)
    null,
    // Pattern 4: Coinbase bundler
    'https://api.developer.coinbase.com/rpc/v1/base-sepolia',
  ].filter(u => u !== null || urls);

  console.log(`\n  CDP_API_KEY_ID: ${apiKeyId ? apiKeyId.slice(0, 20) + '...' : 'NOT SET'}`);
  console.log(`  CDP_PROJECT_ID: ${projectId || 'NOT SET'}`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n[${i + 2}] Testing ${url ? url.slice(0, 60) + '...' : 'NO paymaster URL'}...`);
    try {
      const opts = {
        smartAccount: smart,
        network: 'base-sepolia',
        calls: [{
          to: '0x0000000000000000000000000000000000000001',
          value: 0n,
          data: '0x',
        }],
      };
      if (url) opts.paymasterUrl = url;

      const result = await cdp.evm.sendUserOperation(opts);
      console.log(`  ✅ SUCCESS! userOpHash: ${result.userOpHash}`);
      console.log(`  Working paymaster URL: ${url || 'none (SDK default)'}`);
      process.exit(0);
    } catch (err) {
      console.log(`  ❌ ${err.errorMessage || err.message}`);
    }
  }

  console.log('\n❌ ALL paymaster URLs failed.');
  console.log('\nDo you have CDP_PROJECT_ID set in your .env?');
  console.log('Get it from https://portal.cdp.coinbase.com → your project settings.');
})().catch(console.error);
