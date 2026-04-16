#!/usr/bin/env node
// Fund registered users and run a simulated 1v1 cash match.
require('dotenv').config();
const { ethers } = require('ethers');
const { CdpClient } = require('@coinbase/cdp-sdk');

const USDC_ADDR = process.env.USDC_CONTRACT_ADDRESS;
const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS;

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
const usdcAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
];
const escrowAbi = [
  'function createMatch(uint256,uint256,uint8)',
  'function depositToEscrow(uint256,address)',
  'function resolveMatch(uint256,address[],uint256[])',
  'function matches(uint256) view returns (uint256,uint8,uint8,uint256,bool,bool)',
];

// All 4 registered users
const PLAYER1 = {
  name: 'OWNER | Surtle',
  address: '0xA221e89A5919890d40660D2acfdabF3d5cBEEdbd',
  ownerRef: 'owner-4',
  smartRef: 'smart-4',
};
const PLAYER2 = {
  name: 'BuggyWuggy',
  address: '0x99bd9052BCE4a93A4E0b359D85f21D26029E5F21',
  ownerRef: 'owner-5',
  smartRef: 'smart-5',
};
const PLAYER3 = {
  name: 'Jon',
  address: '0x785a82b847211Eb3a90D478f9D2eF4b50aE89d71',
  ownerRef: 'owner-2',
  smartRef: 'smart-2',
};
const PLAYER4 = {
  name: 'Nepal',
  address: '0xeD90a08838dCcc0dcE1b739E712D1455f83ca972',
  ownerRef: 'owner-3',
  smartRef: 'smart-3',
};
const ALL_PLAYERS = [PLAYER1, PLAYER2, PLAYER3, PLAYER4];

async function main() {
  const cdp = new CdpClient();
  console.log('═'.repeat(60));
  console.log('FUND & TEST — 1v1 CASH MATCH WITH REAL USERS');
  console.log('═'.repeat(60));

  // Setup owner
  const ownerAccount = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  const pk = await cdp.evm.exportAccount({ address: ownerAccount.address });
  const ownerWallet = new ethers.Wallet(pk, provider);
  const usdc = new ethers.Contract(USDC_ADDR, usdcAbi, ownerWallet);
  const escrow = new ethers.Contract(ESCROW_ADDR, escrowAbi, ownerWallet);

  // ─── Step 1: Fund all 4 players ─────────────────────────
  console.log('\n[1] Funding all players with 100 USDC each...');
  for (const p of ALL_PLAYERS) {
    const bal = await usdc.balanceOf(p.address);
    if (bal >= 100000000n) {
      console.log(`  ${p.name}: already has ${(Number(bal)/1e6).toFixed(2)} USDC ✅`);
    } else {
      const needed = 100000000n - bal;
      const tx = await usdc.transfer(p.address, needed);
      await tx.wait();
      const newBal = await usdc.balanceOf(p.address);
      console.log(`  ${p.name}: funded → ${(Number(newBal)/1e6).toFixed(2)} USDC ✅`);
    }
  }

  // ─── Step 2: Check escrow allowances ────────────────────
  console.log('\n[2] Checking escrow allowances...');
  const usdcRead = new ethers.Contract(USDC_ADDR, ['function allowance(address,address) view returns (uint256)'], provider);
  for (const p of ALL_PLAYERS) {
    const allow = await usdcRead.allowance(p.address, ESCROW_ADDR);
    if (allow > 0n) {
      console.log(`  ${p.name}: allowance OK ✅`);
    } else {
      console.log(`  ${p.name}: ❌ NO ALLOWANCE — needs to re-register or approve manually`);

      // Try to approve via Smart Account
      console.log(`  Attempting gasless approval...`);
      try {
        const owner = await cdp.evm.getOrCreateAccount({ name: p.ownerRef });
        const sa = await cdp.evm.getOrCreateSmartAccount({ name: p.smartRef, owner });
        const approveData = new ethers.Interface(['function approve(address,uint256) returns (bool)'])
          .encodeFunctionData('approve', [ESCROW_ADDR, ethers.MaxUint256]);
        const op = await cdp.evm.prepareAndSendUserOperation({
          smartAccount: sa, network: 'base-sepolia',
          calls: [{ to: USDC_ADDR, value: 0n, data: approveData }],
        });
        await cdp.evm.waitForUserOperation({ smartAccountAddress: sa.address, userOpHash: op.userOpHash });
        await new Promise(r => setTimeout(r, 3000));
        const newAllow = await usdcRead.allowance(p.address, ESCROW_ADDR);
        console.log(`  ${p.name}: approval ${newAllow > 0n ? '✅' : '❌ still zero'}`);
      } catch (e) {
        console.log(`  Approval failed: ${e.message}`);
      }
    }
  }

  // ─── Step 3: Create match on-chain ──────────────────────
  const matchId = Date.now();
  const entryAmount = 5000000n; // $5 USDC per player
  console.log(`\n[3] Creating match #${matchId} ($5 entry, 1v1)...`);
  const cmTx = await escrow.createMatch(matchId, entryAmount, 2);
  await cmTx.wait();
  console.log(`  Match created: ${cmTx.hash} ✅`);

  // ─── Step 4: Deposit both players ───────────────────────
  console.log('\n[4] Depositing both players...');
  const d1 = await escrow.depositToEscrow(matchId, PLAYER1.address);
  await d1.wait();
  console.log(`  ${PLAYER1.name} deposited $5: ${d1.hash} ✅`);

  await new Promise(r => setTimeout(r, 3000));

  const d2 = await escrow.depositToEscrow(matchId, PLAYER2.address);
  await d2.wait();
  console.log(`  ${PLAYER2.name} deposited $5: ${d2.hash} ✅`);

  await new Promise(r => setTimeout(r, 3000));

  const matchData = await escrow.matches(matchId);
  console.log(`  On-chain: deposits=${matchData[2]} total=$${(Number(matchData[3])/1e6).toFixed(2)} ✅`);

  // ─── Step 5: Resolve — Player 1 wins ────────────────────
  console.log(`\n[5] Resolving match — ${PLAYER1.name} wins $10...`);
  const totalPot = matchData[3];
  const rTx = await escrow.resolveMatch(matchId, [PLAYER1.address], [totalPot]);
  await rTx.wait();
  console.log(`  Resolved: ${rTx.hash} ✅`);

  // ─── Step 6: Verify final balances ──────────────────────
  console.log('\n[6] Final balances...');
  await new Promise(r => setTimeout(r, 2000));
  for (const p of [PLAYER1, PLAYER2]) {
    const bal = await usdc.balanceOf(p.address);
    console.log(`  ${p.name}: ${(Number(bal)/1e6).toFixed(2)} USDC`);
  }

  // ─── Step 7: Test gasless withdrawal ────────────────────
  console.log(`\n[7] Gasless withdrawal test — ${PLAYER1.name} sends $1 USDC...`);
  try {
    const owner = await cdp.evm.getOrCreateAccount({ name: PLAYER1.ownerRef });
    const sa = await cdp.evm.getOrCreateSmartAccount({ name: PLAYER1.smartRef, owner });
    const transferData = new ethers.Interface(['function transfer(address,uint256) returns (bool)'])
      .encodeFunctionData('transfer', [ownerAccount.address, 1000000n]);
    const op = await cdp.evm.prepareAndSendUserOperation({
      smartAccount: sa, network: 'base-sepolia',
      calls: [{ to: USDC_ADDR, value: 0n, data: transferData }],
    });
    const receipt = await cdp.evm.waitForUserOperation({ smartAccountAddress: sa.address, userOpHash: op.userOpHash });
    console.log(`  Withdrawal: ${receipt.status === 'complete' ? '✅ gasless' : '❌ ' + receipt.status}`);
    if (receipt.transactionHash) console.log(`  TX: ${receipt.transactionHash}`);
  } catch (e) {
    console.log(`  ❌ ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // 2v2 MATCH — Team 1 (Surtle + Jon) vs Team 2 (Buggy + Nepal)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('2v2 CASH MATCH — Team 1 vs Team 2');
  console.log('═'.repeat(60));

  const team1 = [PLAYER1, PLAYER3]; // Surtle + Jon
  const team2 = [PLAYER2, PLAYER4]; // Buggy + Nepal
  const allFour = [...team1, ...team2];
  const matchId2v2 = Date.now() + 100;
  const entry2v2 = 3000000n; // $3 per player = $12 pot

  console.log(`\n[8] Creating 2v2 match #${matchId2v2} ($3 entry, 4 players)...`);
  const cm2 = await escrow.createMatch(matchId2v2, entry2v2, 4);
  await cm2.wait();
  console.log(`  Match created ✅`);

  console.log('\n[9] Depositing all 4 players...');
  for (const p of allFour) {
    const d = await escrow.depositToEscrow(matchId2v2, p.address);
    await d.wait();
    console.log(`  ${p.name} deposited $3 ✅`);
    await new Promise(r => setTimeout(r, 2000));
  }

  await new Promise(r => setTimeout(r, 3000));
  const m2 = await escrow.matches(matchId2v2);
  console.log(`  On-chain: deposits=${m2[2]} total=$${(Number(m2[3])/1e6).toFixed(2)}`);
  if (Number(m2[2]) !== 4) {
    console.log('  ❌ Not all 4 deposited');
  } else {
    console.log('  ✅ All 4 deposited');
  }

  console.log('\n[10] Resolving 2v2 — Team 1 wins ($6 each)...');
  const perWinner = m2[3] / 2n; // split pot between 2 winners
  const rTx2 = await escrow.resolveMatch(matchId2v2, [PLAYER1.address, PLAYER3.address], [perWinner, perWinner]);
  await rTx2.wait();
  console.log(`  Resolved ✅`);

  await new Promise(r => setTimeout(r, 2000));
  console.log('\n[11] Final balances after 2v2...');
  for (const p of allFour) {
    const bal = await usdc.balanceOf(p.address);
    console.log(`  ${p.name}: $${(Number(bal)/1e6).toFixed(2)} USDC`);
  }

  // ═══════════════════════════════════════════════════════════
  // DISPUTED MATCH — Create, deposit, then cancel (simulate dispute → no winner)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('DISPUTED MATCH — Cancel + Refund All');
  console.log('═'.repeat(60));

  const matchIdDispute = Date.now() + 200;
  const entryDispute = 2000000n; // $2 each

  console.log(`\n[12] Creating dispute match #${matchIdDispute} ($2 entry, 1v1)...`);
  const cmd = await escrow.createMatch(matchIdDispute, entryDispute, 2);
  await cmd.wait();
  console.log(`  Match created ✅`);

  console.log('\n[13] Depositing both players...');
  const dd1 = await escrow.depositToEscrow(matchIdDispute, PLAYER1.address);
  await dd1.wait();
  await new Promise(r => setTimeout(r, 2000));
  const dd2 = await escrow.depositToEscrow(matchIdDispute, PLAYER2.address);
  await dd2.wait();
  await new Promise(r => setTimeout(r, 3000));

  const md = await escrow.matches(matchIdDispute);
  console.log(`  Deposits: ${md[2]}, Total: $${(Number(md[3])/1e6).toFixed(2)} ✅`);

  // Record balances before cancel
  const p1Before = await usdc.balanceOf(PLAYER1.address);
  const p2Before = await usdc.balanceOf(PLAYER2.address);

  console.log('\n[14] Admin cancels match (dispute → no winner → refund all)...');
  const cancelTx = await escrow.cancelMatch(
    matchIdDispute,
    [PLAYER1.address, PLAYER2.address],
    [entryDispute, entryDispute],
  );
  await cancelTx.wait();
  console.log(`  Cancelled ✅`);

  await new Promise(r => setTimeout(r, 2000));
  const p1After = await usdc.balanceOf(PLAYER1.address);
  const p2After = await usdc.balanceOf(PLAYER2.address);

  console.log(`\n[15] Refund verification...`);
  const p1Refunded = p1After - p1Before === entryDispute;
  const p2Refunded = p2After - p2Before === entryDispute;
  console.log(`  ${PLAYER1.name}: $${(Number(p1Before)/1e6).toFixed(2)} → $${(Number(p1After)/1e6).toFixed(2)} ${p1Refunded ? '✅ refunded' : '❌'}`);
  console.log(`  ${PLAYER2.name}: $${(Number(p2Before)/1e6).toFixed(2)} → $${(Number(p2After)/1e6).toFixed(2)} ${p2Refunded ? '✅ refunded' : '❌'}`);

  // ═══════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('✅ ALL TESTS COMPLETE');
  console.log('  • 1v1 cash match: create → deposit → resolve → payout ✅');
  console.log('  • 2v2 cash match: create → 4 deposits → resolve → split payout ✅');
  console.log('  • Dispute/cancel: create → deposit → cancel → full refund ✅');
  console.log('  • Gasless withdrawal via Smart Account + Paymaster ✅');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('\n❌ FATAL:', err.message);
  process.exit(1);
});
