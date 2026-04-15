#!/usr/bin/env node
// ─── CDP Smart Account Diagnostic Test ─────────────────────
//
// Tests every CDP sendUserOperation path on Base Sepolia.
//
// The SDK has THREE ways to do smart account operations:
//
//   1. cdp.evm.sendUserOperation() — 3-step flow:
//      prepareUserOperation (server) -> owner.sign({ hash }) -> sendUserOperation (server)
//      Works with CDP server accounts OR local viem keys as owner.
//      On Base Sepolia, gas is subsidized — no paymasterUrl needed.
//
//   2. cdp.evm.prepareAndSendUserOperation() — 1-step flow:
//      Server handles prepare + sign + send in a single API call.
//      ONLY works when the smart account owner is a CDP server account.
//      Endpoint: POST /v2/evm/smart-accounts/{address}/user-operations/prepare-and-send
//
//   3. smartAccount.sendUserOperation() — convenience wrapper for #1.
//      Same 3-step flow, just called on the object instead of cdp.evm.
//
// Usage:
//   node scripts/test-smart-account.js
//
// Requires: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in .env

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');

const NETWORK = 'base-sepolia';

(async () => {
  const cdp = new CdpClient();
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
  let passed = 0;
  let failed = 0;

  // ─── Step 1: Create owner + smart account ─────────────────
  console.log('=== Step 1: Create CDP server account (owner) ===');
  const owner = await cdp.evm.getOrCreateAccount({ name: 'test-smart-owner-v2' });
  console.log(`  Owner address: ${owner.address}`);
  console.log(`  Owner type:    ${owner.type}`);

  console.log('\n=== Step 2: Create smart account ===');
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: 'test-smart-v2',
    owner,
  });
  console.log(`  Smart Account: ${smartAccount.address}`);
  console.log(`  SA type:       ${smartAccount.type}`);
  console.log(`  Owner[0]:      ${smartAccount.owners[0].address}`);

  // Check if smart account is already deployed
  const code = await provider.getCode(smartAccount.address);
  console.log(`  Deployed:      ${code !== '0x' ? 'YES' : 'NO (counterfactual — deploys on first UserOp)'}`);

  // ─── Step 3: Test owner.sign() ────────────────────────────
  console.log('\n=== Step 3: Test owner.sign({ hash }) ===');
  try {
    const testHash = '0x' + 'ab'.repeat(32);
    const sig = await owner.sign({ hash: testHash });
    console.log(`  Signature: ${sig.slice(0, 20)}...${sig.slice(-10)}`);
    const sigBytes = (sig.length - 2) / 2;
    console.log(`  Length:    ${sigBytes} bytes ${sigBytes === 65 ? '(correct)' : '(WRONG — must be 65)'}`);
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
    failed++;
  }

  // ─── Test A: prepareAndSendUserOperation (1-step) ─────────
  // This is the RECOMMENDED approach for server wallets.
  // The server handles prepare + sign + send in a single API call.
  console.log('\n=== Test A: cdp.evm.prepareAndSendUserOperation() [1-step, server-side] ===');
  console.log('  This is the recommended approach for CDP server accounts.');
  console.log('  Endpoint: POST /v2/evm/smart-accounts/{addr}/user-operations/prepare-and-send');
  try {
    const result = await cdp.evm.prepareAndSendUserOperation({
      smartAccount,
      network: NETWORK,
      calls: [{
        to: '0x0000000000000000000000000000000000000000',
        value: 0n,
        data: '0x',
      }],
    });
    console.log(`  userOpHash: ${result.userOpHash}`);
    console.log(`  status:     ${result.status}`);

    console.log('  Waiting for completion...');
    const receipt = await cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: result.userOpHash,
    });
    console.log(`  Final status: ${receipt.status}`);
    if (receipt.transactionHash) {
      console.log(`  Tx hash:      ${receipt.transactionHash}`);
      console.log(`  Explorer:     https://sepolia.basescan.org/tx/${receipt.transactionHash}`);
    }
    console.log('  PASSED');
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.errorMessage || err.message}`);
    if (err.apiError) console.log(`  API error: ${JSON.stringify(err.apiError)}`);
    failed++;
  }

  // ─── Test B: sendUserOperation (3-step) ───────────────────
  console.log('\n=== Test B: cdp.evm.sendUserOperation() [3-step: prepare -> sign -> send] ===');
  try {
    const result = await cdp.evm.sendUserOperation({
      smartAccount,
      network: NETWORK,
      calls: [{
        to: '0x0000000000000000000000000000000000000000',
        value: 0n,
        data: '0x',
      }],
      // No paymasterUrl — Base Sepolia is subsidized by default
    });
    console.log(`  userOpHash: ${result.userOpHash}`);
    console.log(`  status:     ${result.status}`);

    console.log('  Waiting for completion...');
    const receipt = await cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: result.userOpHash,
    });
    console.log(`  Final status: ${receipt.status}`);
    if (receipt.transactionHash) {
      console.log(`  Tx hash:      ${receipt.transactionHash}`);
      console.log(`  Explorer:     https://sepolia.basescan.org/tx/${receipt.transactionHash}`);
    }
    console.log('  PASSED');
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.errorMessage || err.message}`);
    if (err.apiError) console.log(`  API error: ${JSON.stringify(err.apiError)}`);
    failed++;
  }

  // ─── Test C: smartAccount.sendUserOperation() ─────────────
  console.log('\n=== Test C: smartAccount.sendUserOperation() [convenience wrapper] ===');
  try {
    const result = await smartAccount.sendUserOperation({
      network: NETWORK,
      calls: [{
        to: '0x0000000000000000000000000000000000000000',
        value: 0n,
        data: '0x',
      }],
    });
    console.log(`  userOpHash: ${result.userOpHash}`);
    console.log(`  status:     ${result.status}`);
    console.log('  PASSED');
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.errorMessage || err.message}`);
    failed++;
  }

  // ─── Test D: smartAccount.transfer() ──────────────────────
  console.log('\n=== Test D: smartAccount.transfer() [high-level ERC-20] ===');
  try {
    // Request USDC from faucet to the smart account
    console.log('  Requesting USDC faucet...');
    const { transactionHash: faucetTx } = await smartAccount.requestFaucet({
      network: NETWORK,
      token: 'usdc',
    });
    console.log(`  Faucet tx: ${faucetTx}`);
    console.log('  Waiting for faucet confirmation...');
    await provider.waitForTransaction(faucetTx, 1, 30000);

    // Transfer 0.01 USDC from smart account to owner
    const result = await smartAccount.transfer({
      to: owner,
      amount: 10000n, // 0.01 USDC (6 decimals)
      token: 'usdc',
      network: NETWORK,
    });
    console.log(`  userOpHash: ${result.userOpHash}`);

    const receipt = await smartAccount.waitForUserOperation({
      userOpHash: result.userOpHash,
    });
    console.log(`  Final status: ${receipt.status}`);
    console.log('  PASSED');
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.errorMessage || err.message}`);
    failed++;
  }

  // ─── Test E: ERC-20 approve via sendUserOperation ────────
  const usdcAddr = process.env.USDC_CONTRACT_ADDRESS;
  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (usdcAddr && escrowAddr) {
    console.log('\n=== Test E: ERC-20 approve(escrow, MAX) via sendUserOperation ===');
    try {
      const iface = new ethers.Interface([
        'function approve(address spender, uint256 value) returns (bool)',
      ]);
      const data = iface.encodeFunctionData('approve', [escrowAddr, ethers.MaxUint256]);

      const result = await cdp.evm.sendUserOperation({
        smartAccount,
        network: NETWORK,
        calls: [{ to: usdcAddr, value: 0n, data }],
      });
      console.log(`  userOpHash: ${result.userOpHash}`);

      const receipt = await cdp.evm.waitForUserOperation({
        smartAccountAddress: smartAccount.address,
        userOpHash: result.userOpHash,
      });
      console.log(`  Final status: ${receipt.status}`);
      console.log('  PASSED');
      passed++;
    } catch (err) {
      console.log(`  FAILED: ${err.errorMessage || err.message}`);
      failed++;
    }
  } else {
    console.log('\n=== Test E: Skipped (USDC_CONTRACT_ADDRESS or ESCROW_CONTRACT_ADDRESS not set) ===');
  }

  // ─── Test F: EOA sendTransaction (baseline) ───────────────
  console.log('\n=== Test F: EOA sendTransaction (baseline — should always work) ===');
  try {
    const eoa = await cdp.evm.getOrCreateAccount({ name: 'test-eoa-baseline' });
    console.log(`  EOA: ${eoa.address}`);

    await cdp.evm.requestFaucet({ address: eoa.address, network: NETWORK, token: 'eth' });
    console.log('  Faucet sent, waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));

    const result = await cdp.evm.sendTransaction({
      address: eoa.address,
      network: NETWORK,
      transaction: { to: '0x0000000000000000000000000000000000000001', value: 0n, data: '0x' },
    });
    console.log(`  Tx hash: ${result.transactionHash}`);
    console.log('  PASSED');
    passed++;
  } catch (err) {
    console.log(`  FAILED: ${err.errorMessage || err.message}`);
    failed++;
  }

  // ─── Summary ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}`);

  if (failed > 0) {
    console.log('\nIf Tests A-C all fail with "Invalid UserOp signature":');
    console.log('  1. Check CDP Portal -> Paymaster -> Configuration');
    console.log('     - Ensure Base Sepolia is selected as the network');
    console.log('     - Ensure paymaster is enabled (toggle ON)');
    console.log('     - For ERC-20 calls, add the contract to the allowlist');
    console.log('  2. Check that CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET are correct');
    console.log('  3. Try upgrading: npm install @coinbase/cdp-sdk@latest');
    console.log('  4. If only Test A passes but B/C fail, use prepareAndSendUserOperation');
    console.log('     instead of sendUserOperation (server-side signing avoids the bug)');
    console.log('  5. If nothing works, the fallback is EOA + sendTransaction (Test F)');
  }
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
