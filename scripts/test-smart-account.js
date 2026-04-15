#!/usr/bin/env node
// Test Smart Account with explicit paymaster URL for base-sepolia.
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

(async () => {
  const cdp = new CdpClient();

  console.log('[1] Creating EOA + Smart Account...');
  const owner = await cdp.evm.createAccount();
  const smart = await cdp.evm.createSmartAccount({ owner });
  console.log(`  Owner: ${owner.address}`);
  console.log(`  Smart: ${smart.address}`);

  // Generate the paymaster URL the same way the SDK does for mainnet
  console.log('\n[2] Getting paymaster URL...');
  let paymasterUrl;
  try {
    // The SDK has an internal function for this — replicate it
    const config = require('@coinbase/cdp-sdk/_cjs/openapi-client/cdpApiClient').config;
    const basePath = config.basePath?.replace('/platform', '');
    const { generateJwt } = require('@coinbase/cdp-sdk/_cjs/auth/utils/jwt');
    const jwt = await generateJwt({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      requestMethod: 'GET',
      requestHost: basePath.replace('https://', ''),
      requestPath: '/apikeys/v1/tokens/active',
    });
    const res = await fetch(`${basePath}/apikeys/v1/tokens/active`, {
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    });
    const json = await res.json();
    paymasterUrl = `${basePath}/rpc/v1/base-sepolia/${json.id}`;
    console.log(`  Paymaster URL: ${paymasterUrl}`);
  } catch (err) {
    console.error(`  Failed to get paymaster URL: ${err.message}`);
    console.log('  Trying without paymaster...');
  }

  console.log('\n[3] Sending UserOperation WITH paymaster URL...');
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
    if (paymasterUrl) opts.paymasterUrl = paymasterUrl;

    const result = await cdp.evm.sendUserOperation(opts);
    console.log(`  ✅ Success! userOpHash: ${result.userOpHash}`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.errorMessage || err.message}`);
  }

  console.log('\n[4] Trying with hardcoded CDP paymaster pattern...');
  try {
    // Try the pattern from the SDK docs example
    const projectId = process.env.CDP_API_KEY_ID;
    const manualUrl = `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${projectId}`;
    console.log(`  URL: ${manualUrl}`);

    const result = await cdp.evm.sendUserOperation({
      smartAccount: smart,
      network: 'base-sepolia',
      paymasterUrl: manualUrl,
      calls: [{
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        data: '0x',
      }],
    });
    console.log(`  ✅ Success! userOpHash: ${result.userOpHash}`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.errorMessage || err.message}`);
  }
})().catch(console.error);
