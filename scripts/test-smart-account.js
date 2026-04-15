#!/usr/bin/env node
// Try every possible approach to make sendUserOperation work
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');

(async () => {
  const cdp = new CdpClient();
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
  const clientKey = process.env.CDP_CLIENT_API_KEY || '';

  // Approach 1: Use the SDK's transfer method on a Smart Account
  // The SDK README shows: smartAccount.transfer() — maybe this handles UserOps internally
  console.log('=== Approach 1: Smart Account transfer() method ===');
  try {
    const owner1 = await cdp.evm.createAccount();
    const smart1 = await cdp.evm.createSmartAccount({ owner: owner1 });
    console.log(`Smart: ${smart1.address}`);

    // Fund smart account with ETH first
    await cdp.evm.requestFaucet({ address: smart1.address, network: 'base-sepolia', token: 'eth' });
    console.log('Faucet sent, waiting...');
    await new Promise(r => setTimeout(r, 8000));

    const bal = await provider.getBalance(smart1.address);
    console.log(`ETH balance: ${ethers.formatEther(bal)}`);

    // Check if smart account has code deployed
    const code = await provider.getCode(smart1.address);
    console.log(`Contract deployed: ${code !== '0x' ? 'YES' : 'NO (counterfactual)'}`);

    // Try transfer method if it exists
    if (typeof smart1.transfer === 'function') {
      console.log('transfer() method exists, trying...');
      const result = await smart1.transfer({
        to: owner1.address,
        amount: 1n,
        token: 'eth',
        network: 'base-sepolia',
      });
      console.log(`✅ transfer() worked: ${result.transactionHash}`);
    } else {
      console.log('transfer() method not available on smart account');
    }
  } catch (err) {
    console.log(`❌ ${err.errorMessage || err.message}`);
  }

  // Approach 2: Use sendTransaction on the smart account address directly
  // Maybe CDP treats smart account addresses the same as EOA for sendTransaction
  console.log('\n=== Approach 2: sendTransaction with smart account address ===');
  try {
    const owner2 = await cdp.evm.createAccount();
    const smart2 = await cdp.evm.createSmartAccount({ owner: owner2 });
    console.log(`Smart: ${smart2.address}`);

    await cdp.evm.requestFaucet({ address: smart2.address, network: 'base-sepolia', token: 'eth' });
    await new Promise(r => setTimeout(r, 8000));

    const result = await cdp.evm.sendTransaction({
      address: smart2.address,
      network: 'base-sepolia',
      transaction: {
        to: '0x0000000000000000000000000000000000000001',
        value: 0n,
        data: '0x',
      },
    });
    console.log(`✅ sendTransaction on smart account worked: ${result.transactionHash}`);
  } catch (err) {
    console.log(`❌ ${err.errorMessage || err.message}`);
  }

  // Approach 3: Just use EOA accounts with faucet ETH — no Smart Accounts
  console.log('\n=== Approach 3: Regular EOA with faucet ETH ===');
  try {
    const eoa = await cdp.evm.getOrCreateAccount({ name: 'test-eoa-direct' });
    console.log(`EOA: ${eoa.address}`);

    await cdp.evm.requestFaucet({ address: eoa.address, network: 'base-sepolia', token: 'eth' });
    await new Promise(r => setTimeout(r, 8000));

    // Approve test USDC
    const usdcAddr = process.env.USDC_CONTRACT_ADDRESS;
    const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
    if (usdcAddr && escrowAddr) {
      const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
      const data = iface.encodeFunctionData('approve', [escrowAddr, ethers.MaxUint256]);
      const result = await cdp.evm.sendTransaction({
        address: eoa.address,
        network: 'base-sepolia',
        transaction: { to: usdcAddr, value: 0n, data },
      });
      console.log(`✅ EOA approve worked: ${result.transactionHash}`);
    } else {
      const result = await cdp.evm.sendTransaction({
        address: eoa.address,
        network: 'base-sepolia',
        transaction: { to: '0x0000000000000000000000000000000000000001', value: 0n, data: '0x' },
      });
      console.log(`✅ EOA sendTransaction worked: ${result.transactionHash}`);
    }
  } catch (err) {
    console.log(`❌ ${err.errorMessage || err.message}`);
  }

  console.log('\n=== Summary ===');
  console.log('If Approach 3 works, we use EOA accounts with auto-faucet on testnet.');
  console.log('On mainnet, gas is $0.01/tx — bot auto-funds each user wallet.');
  console.log('Smart Accounts can be revisited when CDP fixes the UserOp signature issue.');
})().catch(console.error);
