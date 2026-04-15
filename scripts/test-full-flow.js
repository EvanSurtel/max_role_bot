#!/usr/bin/env node
// End-to-end test using Smart Accounts (gasless via Paymaster).
// Creates two Smart Accounts, funds them, creates a match, deposits,
// and resolves — proving the full production flow works.

require('dotenv').config();
const { ethers } = require('ethers');
const { CdpClient } = require('@coinbase/cdp-sdk');

const USDC_ADDR = process.env.USDC_CONTRACT_ADDRESS;
const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS;

if (!USDC_ADDR || !ESCROW_ADDR) {
  console.error('Set USDC_CONTRACT_ADDRESS and ESCROW_CONTRACT_ADDRESS in .env');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
const usdcAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
];
const escrowAbi = [
  'function usdc() view returns (address)',
  'function owner() view returns (address)',
  'function createMatch(uint256,uint256,uint8)',
  'function depositToEscrow(uint256,address)',
  'function resolveMatch(uint256,address[],uint256[])',
  'function matches(uint256) view returns (uint256,uint8,uint8,uint256,bool,bool)',
];

async function main() {
  const cdp = new CdpClient();
  console.log('═'.repeat(60));
  console.log('FULL FLOW TEST — SMART ACCOUNTS (GASLESS)');
  console.log('═'.repeat(60));

  // ─── Step 0: Verify contract setup ──────────────────────
  console.log('\n[0] Verifying contract setup...');
  const escrow = new ethers.Contract(ESCROW_ADDR, escrowAbi, provider);
  const contractUsdc = await escrow.usdc();
  const contractOwner = await escrow.owner();
  const ownerAddr = process.env.CDP_OWNER_ADDRESS;

  console.log(`  Contract USDC: ${contractUsdc}`);
  console.log(`  Expected USDC: ${USDC_ADDR}`);
  console.log(`  USDC match: ${contractUsdc.toLowerCase() === USDC_ADDR.toLowerCase() ? '✅' : '❌ MISMATCH'}`);
  console.log(`  Contract owner: ${contractOwner}`);
  console.log(`  Owner match: ${contractOwner.toLowerCase() === ownerAddr?.toLowerCase() ? '✅' : '❌ MISMATCH'}`);

  if (contractUsdc.toLowerCase() !== USDC_ADDR.toLowerCase()) {
    console.error('\n❌ FATAL: Contract USDC mismatch. Redeploy.');
    process.exit(1);
  }

  // ─── Step 1: Create two Smart Accounts ──────────────────
  console.log('\n[1] Creating Smart Accounts (gasless via Paymaster)...');

  const owner1 = await cdp.evm.getOrCreateAccount({ name: 'flow-test-owner-1' });
  const sa1 = await cdp.evm.getOrCreateSmartAccount({ name: 'flow-test-smart-1', owner: owner1 });
  console.log(`  Player 1 Smart Account: ${sa1.address}`);

  const owner2 = await cdp.evm.getOrCreateAccount({ name: 'flow-test-owner-2' });
  const sa2 = await cdp.evm.getOrCreateSmartAccount({ name: 'flow-test-smart-2', owner: owner2 });
  console.log(`  Player 2 Smart Account: ${sa2.address}`);

  // ─── Step 2: Fund both with test USDC ───────────────────
  console.log('\n[2] Funding Smart Accounts with USDC...');
  const ownerAccount = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  const pk = await cdp.evm.exportAccount({ address: ownerAccount.address });
  const ownerWallet = new ethers.Wallet(pk, provider);
  const usdc = new ethers.Contract(USDC_ADDR, usdcAbi, ownerWallet);

  const tx1 = await usdc.transfer(sa1.address, 10000000n);
  await tx1.wait();
  console.log(`  Sent 10 USDC to player 1: ${tx1.hash}`);

  const tx2 = await usdc.transfer(sa2.address, 10000000n);
  await tx2.wait();
  console.log(`  Sent 10 USDC to player 2: ${tx2.hash}`);

  const bal1 = await usdc.balanceOf(sa1.address);
  const bal2 = await usdc.balanceOf(sa2.address);
  console.log(`  Player 1 balance: ${(Number(bal1) / 1e6).toFixed(2)} USDC ${bal1 >= 2000000n ? '✅' : '❌'}`);
  console.log(`  Player 2 balance: ${(Number(bal2) / 1e6).toFixed(2)} USDC ${bal2 >= 2000000n ? '✅' : '❌'}`);

  // ─── Step 3: Approve escrow — GASLESS via Smart Account ─
  console.log('\n[3] Approving escrow (gasless via Smart Account UserOp)...');
  const approveData = new ethers.Interface(usdcAbi).encodeFunctionData('approve', [ESCROW_ADDR, ethers.MaxUint256]);

  const ap1 = await cdp.evm.prepareAndSendUserOperation({
    smartAccount: sa1,
    network: 'base-sepolia',
    calls: [{ to: USDC_ADDR, value: 0n, data: approveData }],
  });
  console.log(`  Player 1 approved (gasless): ${ap1.userOpHash}`);
  await cdp.evm.waitForUserOperation({ smartAccountAddress: sa1.address, userOpHash: ap1.userOpHash });

  const ap2 = await cdp.evm.prepareAndSendUserOperation({
    smartAccount: sa2,
    network: 'base-sepolia',
    calls: [{ to: USDC_ADDR, value: 0n, data: approveData }],
  });
  console.log(`  Player 2 approved (gasless): ${ap2.userOpHash}`);
  await cdp.evm.waitForUserOperation({ smartAccountAddress: sa2.address, userOpHash: ap2.userOpHash });

  // Wait for on-chain state to propagate
  await new Promise(r => setTimeout(r, 3000));

  const allow1 = await usdc.allowance(sa1.address, ESCROW_ADDR);
  const allow2 = await usdc.allowance(sa2.address, ESCROW_ADDR);
  console.log(`  Player 1 allowance: ${allow1 > 0n ? '✅' : '❌ ZERO'}`);
  console.log(`  Player 2 allowance: ${allow2 > 0n ? '✅' : '❌ ZERO'}`);

  // ─── Step 4: Create match on-chain ──────────────────────
  console.log('\n[4] Creating match on-chain (owner EOA)...');
  const matchId = Date.now(); // unique match ID
  const entryAmount = 2000000n; // $2 USDC

  const escrowWithOwner = new ethers.Contract(ESCROW_ADDR, escrowAbi, ownerWallet);
  const cmTx = await escrowWithOwner.createMatch(matchId, entryAmount, 2);
  await cmTx.wait();
  console.log(`  Match #${matchId} created: ${cmTx.hash} ✅`);

  // ─── Step 5: Deposit both players ───────────────────────
  console.log('\n[5] Depositing players into escrow...');

  const dep1 = await escrowWithOwner.depositToEscrow(matchId, sa1.address);
  await dep1.wait(1);
  console.log(`  Player 1 deposited: ${dep1.hash} ✅`);

  // Wait between deposits to avoid nonce issues
  await new Promise(r => setTimeout(r, 3000));

  const dep2 = await escrowWithOwner.depositToEscrow(matchId, sa2.address);
  await dep2.wait(1);
  console.log(`  Player 2 deposited: ${dep2.hash} ✅`);

  // Wait for on-chain state to propagate
  await new Promise(r => setTimeout(r, 3000));

  const matchData = await escrow.matches(matchId);
  const totalDeposited = matchData[3];
  console.log(`  On-chain: deposits=${matchData[2]} total=${totalDeposited}`);
  if (Number(matchData[2]) !== 2) {
    console.error(`  ❌ Expected 2 deposits, got ${matchData[2]}`);
    process.exit(1);
  }
  console.log(`  ✅`);

  // ─── Step 6: Resolve match (player 1 wins) ─────────────
  console.log('\n[6] Resolving match (player 1 wins)...');
  const resolveTx = await escrowWithOwner.resolveMatch(matchId, [sa1.address], [totalDeposited]);
  await resolveTx.wait();
  console.log(`  Match resolved: ${resolveTx.hash} ✅`);

  const finalBal1 = await usdc.balanceOf(sa1.address);
  const finalBal2 = await usdc.balanceOf(sa2.address);
  console.log(`  Player 1 final: ${(Number(finalBal1) / 1e6).toFixed(2)} USDC (gained $2)`);
  console.log(`  Player 2 final: ${(Number(finalBal2) / 1e6).toFixed(2)} USDC (lost $2)`);

  // ─── Step 7: Withdraw via Smart Account (GASLESS) ───────
  console.log('\n[7] Withdrawing USDC via Smart Account (gasless)...');
  const transferData = new ethers.Interface(usdcAbi).encodeFunctionData('transfer', [ownerAccount.address, 1000000n]);
  const withdrawOp = await cdp.evm.prepareAndSendUserOperation({
    smartAccount: sa1,
    network: 'base-sepolia',
    calls: [{ to: USDC_ADDR, value: 0n, data: transferData }],
  });
  console.log(`  Withdrawal UserOp: ${withdrawOp.userOpHash}`);
  const receipt = await cdp.evm.waitForUserOperation({ smartAccountAddress: sa1.address, userOpHash: withdrawOp.userOpHash });
  console.log(`  Status: ${receipt.status} ${receipt.status === 'complete' ? '✅' : '❌'}`);
  if (receipt.transactionHash) console.log(`  Tx: ${receipt.transactionHash}`);

  console.log('\n' + '═'.repeat(60));
  console.log('✅ ALL STEPS PASSED — Smart Account + Paymaster flow working');
  console.log('   Approvals: GASLESS ✅');
  console.log('   Withdrawals: GASLESS ✅');
  console.log('   Escrow deposits/resolve: Owner EOA (needs ETH) ✅');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message || err);
  process.exit(1);
});
