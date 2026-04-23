#!/usr/bin/env node
// Approve the current WagerEscrow contract for USDC from the
// escrow-owner-smart Smart Account. This is a one-shot bring-up op
// required for the self-custody match-deposit path:
//
//   user's Smart Wallet
//      ↓ (SpendPermissionManager.spend)
//   escrow-owner-smart  ←  this approve() lets the next step work
//      ↓ (WagerEscrow.depositFromSpender → safeTransferFrom)
//   WagerEscrow
//
// The deploy script (deploy-escrow.js) already runs this as part of
// a fresh deployment. Use this standalone script if the deploy-time
// approve failed, or if you need to re-approve against a different
// escrow contract address, or if you're wiring up an existing deploy
// for the first time without redeploying.
//
// Idempotent: if allowance is already > 1 billion USDC units (1000 USDC)
// the script skips the on-chain call.

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');

async function main() {
  const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
  const usdc = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  if (!escrow) throw new Error('ESCROW_CONTRACT_ADDRESS must be set in .env');

  const cdp = new CdpClient();
  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const cdpNetwork = network === 'sepolia' ? 'base-sepolia' : 'base';
  const rpcUrl = process.env.BASE_RPC_URL ||
    (network === 'sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org');

  const owner = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: 'escrow-owner-smart',
    owner,
  });
  console.log(`[Approve] spender (escrow-owner-smart): ${smartAccount.address}`);
  console.log(`[Approve] WagerEscrow:                  ${escrow}`);
  console.log(`[Approve] USDC:                         ${usdc}`);

  // Idempotency check — skip if already approved.
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const usdcContract = new ethers.Contract(
    usdc,
    ['function allowance(address owner, address spender) view returns (uint256)'],
    provider,
  );
  const current = await usdcContract.allowance(smartAccount.address, escrow);
  if (current > 1_000_000_000n) {
    console.log(`[Approve] Current allowance ${current} already sufficient — skipping.`);
    return;
  }

  const MAX_UINT256 = (1n << 256n) - 1n;
  const iface = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [escrow, MAX_UINT256]);

  console.log('[Approve] Submitting UserOp…');
  const res = await cdp.evm.prepareAndSendUserOperation({
    smartAccount,
    network: cdpNetwork,
    ...(process.env.PAYMASTER_RPC_URL ? { paymasterUrl: process.env.PAYMASTER_RPC_URL } : {}),
    calls: [{ to: usdc, value: 0n, data }],
  });
  console.log(`[Approve] userOpHash: ${res.userOpHash}`);

  const receipt = await cdp.evm.waitForUserOperation({
    smartAccountAddress: smartAccount.address,
    userOpHash: res.userOpHash,
  });
  console.log(`[Approve] status=${receipt.status} tx=${receipt.transactionHash || '(none)'}`);

  const after = await usdcContract.allowance(smartAccount.address, escrow);
  console.log(`[Approve] Allowance is now: ${after}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[Approve] FATAL:', err);
    process.exit(1);
  },
);
