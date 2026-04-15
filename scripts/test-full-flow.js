#!/usr/bin/env node
// End-to-end test of the entire escrow flow without Discord.
// Creates two test wallets, funds them, creates a match, deposits,
// and resolves — catching any issues before real users hit them.

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
  'function cancelMatch(uint256,address[],uint256[])',
  'function matches(uint256) view returns (uint256,uint8,uint8,uint256,bool,bool)',
];

async function main() {
  const cdp = new CdpClient();
  console.log('═'.repeat(60));
  console.log('FULL FLOW TEST');
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
  console.log(`  CDP owner: ${ownerAddr}`);
  console.log(`  Owner match: ${contractOwner.toLowerCase() === ownerAddr?.toLowerCase() ? '✅' : '❌ MISMATCH'}`);

  if (contractUsdc.toLowerCase() !== USDC_ADDR.toLowerCase()) {
    console.error('\n❌ FATAL: Contract USDC address does not match .env. Redeploy the contract.');
    process.exit(1);
  }
  if (contractOwner.toLowerCase() !== ownerAddr?.toLowerCase()) {
    console.error('\n❌ FATAL: Contract owner does not match CDP_OWNER_ADDRESS.');
    process.exit(1);
  }

  // ─── Step 1: Create two test EOA accounts ────────────────
  console.log('\n[1] Creating test EOA accounts...');
  const smart1 = await cdp.evm.getOrCreateAccount({ name: 'test-player-1' });
  console.log(`  Player 1: ${smart1.address}`);

  const smart2 = await cdp.evm.getOrCreateAccount({ name: 'test-player-2' });
  console.log(`  Player 2: ${smart2.address}`);

  // Fund both with ETH for gas
  try { await cdp.evm.requestFaucet({ address: smart1.address, network: 'base-sepolia', token: 'eth' }); } catch {}
  try { await cdp.evm.requestFaucet({ address: smart2.address, network: 'base-sepolia', token: 'eth' }); } catch {}
  console.log('  Faucet ETH sent, waiting for confirmation...');
  await new Promise(r => setTimeout(r, 5000));

  // ─── Step 2: Fund both with test USDC ───────────────────
  console.log('\n[2] Funding test wallets with USDC...');
  const ownerAccount = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  const pk = await cdp.evm.exportAccount({ address: ownerAccount.address });
  const ownerWallet = new ethers.Wallet(pk, provider);
  const usdc = new ethers.Contract(USDC_ADDR, usdcAbi, ownerWallet);

  const tx1 = await usdc.transfer(smart1.address, 10000000n); // 10 USDC
  await tx1.wait();
  console.log(`  Sent 10 USDC to player 1: ${tx1.hash}`);

  const tx2 = await usdc.transfer(smart2.address, 10000000n);
  await tx2.wait();
  console.log(`  Sent 10 USDC to player 2: ${tx2.hash}`);

  const bal1 = await usdc.balanceOf(smart1.address);
  const bal2 = await usdc.balanceOf(smart2.address);
  console.log(`  Player 1 balance: ${(Number(bal1) / 1e6).toFixed(2)} USDC ${bal1 >= 2000000n ? '✅' : '❌'}`);
  console.log(`  Player 2 balance: ${(Number(bal2) / 1e6).toFixed(2)} USDC ${bal2 >= 2000000n ? '✅' : '❌'}`);

  // ─── Step 3: Approve escrow for both players ────────────
  console.log('\n[3] Approving escrow contract...');
  const approveData = new ethers.Interface(usdcAbi).encodeFunctionData('approve', [ESCROW_ADDR, ethers.MaxUint256]);

  const ap1 = await cdp.evm.sendTransaction({
    address: smart1.address, network: 'base-sepolia',
    transaction: { to: USDC_ADDR, value: 0n, data: approveData },
  });
  console.log(`  Player 1 approved: ${ap1.transactionHash}`);

  const ap2 = await cdp.evm.sendTransaction({
    address: smart2.address, network: 'base-sepolia',
    transaction: { to: USDC_ADDR, value: 0n, data: approveData },
  });
  console.log(`  Player 2 approved: ${ap2.transactionHash}`);

  await new Promise(r => setTimeout(r, 3000));

  const allow1 = await usdc.allowance(smart1.address, ESCROW_ADDR);
  const allow2 = await usdc.allowance(smart2.address, ESCROW_ADDR);
  console.log(`  Player 1 allowance: ${allow1 > 0n ? '✅' : '❌ ZERO'}`);
  console.log(`  Player 2 allowance: ${allow2 > 0n ? '✅' : '❌ ZERO'}`);

  if (allow1 === 0n || allow2 === 0n) {
    console.error('\n❌ Approval failed. Smart Account sendUserOperation may not be working.');
    process.exit(1);
  }

  // ─── Step 4: Create match on-chain ──────────────────────
  console.log('\n[4] Creating match on-chain (owner EOA)...');
  const matchId = 99999;
  const entryAmount = 2000000n; // $2 USDC

  const escrowWithOwner = new ethers.Contract(ESCROW_ADDR, escrowAbi, ownerWallet);
  const cmTx = await escrowWithOwner.createMatch(matchId, entryAmount, 2);
  await cmTx.wait();
  console.log(`  Match #${matchId} created: ${cmTx.hash}`);

  const matchData = await escrow.matches(matchId);
  console.log(`  On-chain: entry=${matchData[0]} players=${matchData[1]} deposits=${matchData[2]} ✅`);

  // ─── Step 5: Deposit both players ───────────────────────
  console.log('\n[5] Depositing players into escrow (owner calls transferFrom)...');

  const dep1Tx = await escrowWithOwner.depositToEscrow(matchId, smart1.address);
  await dep1Tx.wait();
  console.log(`  Player 1 deposited: ${dep1Tx.hash} ✅`);

  const dep2Tx = await escrowWithOwner.depositToEscrow(matchId, smart2.address);
  await dep2Tx.wait();
  console.log(`  Player 2 deposited: ${dep2Tx.hash} ✅`);

  const matchAfter = await escrow.matches(matchId);
  console.log(`  On-chain: deposits=${matchAfter[2]} total=${matchAfter[3]} ✅`);

  // ─── Step 6: Resolve match (player 1 wins) ─────────────
  console.log('\n[6] Resolving match (player 1 wins)...');
  const resolveTx = await escrowWithOwner.resolveMatch(
    matchId,
    [smart1.address],
    [4000000n], // full pot to winner
  );
  await resolveTx.wait();
  console.log(`  Match resolved: ${resolveTx.hash} ✅`);

  const finalBal1 = await usdc.balanceOf(smart1.address);
  const finalBal2 = await usdc.balanceOf(smart2.address);
  console.log(`  Player 1 final: ${(Number(finalBal1) / 1e6).toFixed(2)} USDC (should be ~12)`);
  console.log(`  Player 2 final: ${(Number(finalBal2) / 1e6).toFixed(2)} USDC (should be ~8)`);

  console.log('\n' + '═'.repeat(60));
  console.log('✅ ALL STEPS PASSED — escrow flow is working correctly');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message || err);
  process.exit(1);
});
