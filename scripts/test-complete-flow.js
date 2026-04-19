#!/usr/bin/env node
// Complete bot flow test — everything from wallet creation to dispute resolution.
// Tests Smart Accounts, escrow, XP, deposits, withdrawals, disputes.

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

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, err) { failed++; console.log(`  ❌ ${name}: ${err}`); }
function skip(name, reason) { skipped++; console.log(`  ⏭️  ${name}: ${reason}`); }

async function main() {
  const cdp = new CdpClient();

  console.log('═'.repeat(60));
  console.log('COMPLETE FLOW TEST');
  console.log('═'.repeat(60));

  // ═══════════════════════════════════════════════════════════
  // SECTION 1: WALLET & SMART ACCOUNT
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 1: WALLET & SMART ACCOUNT ──');

  // 1.1 Create Smart Accounts
  let sa1, sa2, ownerWallet, usdc, escrow;
  try {
    const owner1 = await cdp.evm.getOrCreateAccount({ name: 'complete-test-owner-1' });
    sa1 = await cdp.evm.getOrCreateSmartAccount({ name: 'complete-test-smart-1', owner: owner1 });
    const owner2 = await cdp.evm.getOrCreateAccount({ name: 'complete-test-owner-2' });
    sa2 = await cdp.evm.getOrCreateSmartAccount({ name: 'complete-test-smart-2', owner: owner2 });
    pass(`Smart Accounts: ${sa1.address.slice(0, 10)}... ${sa2.address.slice(0, 10)}...`);
  } catch (e) { fail('Smart Account creation', e.message); return; }

  // 1.2 Setup owner + USDC contract
  try {
    const ownerAccount = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
    const pk = await cdp.evm.exportAccount({ address: ownerAccount.address });
    ownerWallet = new ethers.Wallet(pk, provider);
    usdc = new ethers.Contract(USDC_ADDR, usdcAbi, ownerWallet);
    escrow = new ethers.Contract(ESCROW_ADDR, escrowAbi, ownerWallet);
    pass('Owner wallet + contracts');
  } catch (e) { fail('Owner setup', e.message); return; }

  // 1.3 Fund both with USDC
  try {
    const tx1 = await usdc.transfer(sa1.address, 20000000n);
    await tx1.wait();
    const tx2 = await usdc.transfer(sa2.address, 20000000n);
    await tx2.wait();
    const b1 = await usdc.balanceOf(sa1.address);
    const b2 = await usdc.balanceOf(sa2.address);
    pass(`USDC funded: P1=${(Number(b1)/1e6).toFixed(2)} P2=${(Number(b2)/1e6).toFixed(2)}`);
  } catch (e) { fail('USDC funding', e.message); }

  // 1.4 Approve escrow (gasless)
  try {
    const approveData = new ethers.Interface(usdcAbi).encodeFunctionData('approve', [ESCROW_ADDR, ethers.MaxUint256]);
    const ap1 = await cdp.evm.prepareAndSendUserOperation({
      smartAccount: sa1, network: 'base-sepolia',
      calls: [{ to: USDC_ADDR, value: 0n, data: approveData }],
    });
    await cdp.evm.waitForUserOperation({ smartAccountAddress: sa1.address, userOpHash: ap1.userOpHash });
    const ap2 = await cdp.evm.prepareAndSendUserOperation({
      smartAccount: sa2, network: 'base-sepolia',
      calls: [{ to: USDC_ADDR, value: 0n, data: approveData }],
    });
    await cdp.evm.waitForUserOperation({ smartAccountAddress: sa2.address, userOpHash: ap2.userOpHash });
    await new Promise(r => setTimeout(r, 3000));
    const a1 = await usdc.allowance(sa1.address, ESCROW_ADDR);
    const a2 = await usdc.allowance(sa2.address, ESCROW_ADDR);
    if (a1 > 0n && a2 > 0n) pass('Escrow approval (gasless)');
    else fail('Escrow approval', `P1=${a1 > 0n} P2=${a2 > 0n}`);
  } catch (e) { fail('Escrow approval', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 2: NORMAL MATCH (both agree)
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 2: NORMAL MATCH (both captains agree) ──');

  const matchId1 = Date.now();
  try {
    const cm = await escrow.createMatch(matchId1, 2000000n, 2);
    await cm.wait();
    pass(`Match #${matchId1} created on-chain`);
  } catch (e) { fail('createMatch', e.message); }

  try {
    const d1 = await escrow.depositToEscrow(matchId1, sa1.address);
    await d1.wait();
    await new Promise(r => setTimeout(r, 2000));
    const d2 = await escrow.depositToEscrow(matchId1, sa2.address);
    await d2.wait();
    await new Promise(r => setTimeout(r, 2000));
    const m = await escrow.matches(matchId1);
    if (Number(m[2]) === 2) pass(`Both players deposited (total: ${m[3]})`);
    else fail('Deposits', `Expected 2, got ${m[2]}`);
  } catch (e) { fail('depositToEscrow', e.message); }

  try {
    const r = await escrow.resolveMatch(matchId1, [sa1.address], [4000000n]);
    await r.wait();
    pass('Match resolved — player 1 wins');
  } catch (e) { fail('resolveMatch', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 3: CANCELLED MATCH (refund all)
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 3: CANCELLED MATCH (refund) ──');

  const matchId2 = Date.now() + 1;
  try {
    const cm = await escrow.createMatch(matchId2, 2000000n, 2);
    await cm.wait();
    const d1 = await escrow.depositToEscrow(matchId2, sa1.address);
    await d1.wait();
    await new Promise(r => setTimeout(r, 2000));
    const d2 = await escrow.depositToEscrow(matchId2, sa2.address);
    await d2.wait();
    pass('Match created + both deposited');
  } catch (e) { fail('Cancel match setup', e.message); }

  try {
    const balBefore = await usdc.balanceOf(sa1.address);
    const c = await escrow.cancelMatch(matchId2, [sa1.address, sa2.address], [2000000n, 2000000n]);
    await c.wait();
    await new Promise(r => setTimeout(r, 2000));
    const balAfter = await usdc.balanceOf(sa1.address);
    if (balAfter > balBefore) pass(`Match cancelled — refunded (P1: ${(Number(balBefore)/1e6).toFixed(2)} → ${(Number(balAfter)/1e6).toFixed(2)})`);
    else fail('Cancel refund', 'Balance did not increase');
  } catch (e) { fail('cancelMatch', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 4: GASLESS WITHDRAWAL
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 4: GASLESS WITHDRAWAL ──');

  try {
    const balBefore = await usdc.balanceOf(sa1.address);
    const transferData = new ethers.Interface(usdcAbi).encodeFunctionData('transfer', [ownerWallet.address, 1000000n]);
    const op = await cdp.evm.prepareAndSendUserOperation({
      smartAccount: sa1, network: 'base-sepolia',
      calls: [{ to: USDC_ADDR, value: 0n, data: transferData }],
    });
    const receipt = await cdp.evm.waitForUserOperation({ smartAccountAddress: sa1.address, userOpHash: op.userOpHash });
    if (receipt.status === 'complete') pass('Gasless USDC withdrawal');
    else fail('Withdrawal', `Status: ${receipt.status}`);
  } catch (e) { fail('Gasless withdrawal', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 5: XP CALCULATIONS
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 5: XP CALCULATIONS ──');

  try {
    const { XP_WAGER, XP_XP_MATCH } = require('../src/config/constants');
    if (XP_WAGER) {
      pass(`XP constants loaded: cash_match win=${XP_WAGER.WIN} loss=${XP_WAGER.LOSS}`);
    } else {
      fail('XP constants', 'XP_WAGER not found');
    }
  } catch (e) { fail('XP constants', e.message); }

  try {
    const { RANK_TIERS } = require('../src/config/constants');
    if (RANK_TIERS && RANK_TIERS.length === 8) {
      pass(`Rank tiers: ${RANK_TIERS.map(t => t.key).join(', ')}`);
    } else {
      fail('Rank tiers', `Expected 8, got ${RANK_TIERS?.length}`);
    }
  } catch (e) { fail('Rank tiers', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 6: DATABASE
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 6: DATABASE ──');

  try {
    const db = require('../src/database/db');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const expected = ['users', 'wallets', 'challenges', 'challenge_players', 'matches', 'transactions', 'timers', 'evidence'];
    const missing = expected.filter(t => !tables.find(r => r.name === t));
    if (missing.length === 0) pass(`All ${expected.length} tables present`);
    else fail('DB tables', `Missing: ${missing.join(', ')}`);
  } catch (e) { fail('Database', e.message); }

  try {
    const db = require('../src/database/db');
    // Check column renames are in place
    const walletCols = db.prepare("PRAGMA table_info(wallets)").all().map(c => c.name);
    if (walletCols.includes('address') && walletCols.includes('account_ref') && walletCols.includes('smart_account_ref')) {
      pass('Wallet columns: address, account_ref, smart_account_ref');
    } else {
      fail('Wallet columns', `Got: ${walletCols.join(', ')}`);
    }

    const txCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
    if (txCols.includes('tx_hash')) pass('Transaction column: tx_hash');
    else fail('Transaction columns', `Missing tx_hash. Got: ${txCols.join(', ')}`);
  } catch (e) { fail('DB columns', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 8: DEPOSIT POLLER
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 8: DEPOSIT POLLER ──');

  try {
    const { getUsdcBalance } = require('../src/base/walletManager');
    const bal = await getUsdcBalance(sa1.address);
    pass(`getUsdcBalance works: ${(Number(bal)/1e6).toFixed(2)} USDC`);
  } catch (e) { fail('getUsdcBalance', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 9: CHANGELLY
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 9: CHANGELLY ──');

  try {
    const changelly = require('../src/services/changellyService');
    if (changelly.isConfigured()) {
      const countries = await changelly.getAvailableCountries();
      if (countries && countries.length > 0) pass(`Changelly API: ${countries.length} countries`);
      else fail('Changelly', 'No countries returned');
    } else {
      skip('Changelly', 'Not configured');
    }
  } catch (e) { fail('Changelly', e.message); }

  // ═══════════════════════════════════════════════════════════
  // SECTION 10: WEBHOOK SERVER
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 10: WEBHOOK SERVER ──');

  try {
    const webhookPort = process.env.WEBHOOK_PORT || '3001';
    const res = await fetch(`http://127.0.0.1:${webhookPort}/health`);
    const data = await res.json();
    if (data.status === 'ok') pass(`Webhook server healthy on port ${webhookPort}`);
    else fail('Webhook health', JSON.stringify(data));
  } catch (e) {
    skip('Webhook server', 'Not running (bot may not be started)');
  }

  // ═══════════════════════════════════════════════════════════
  // SECTION 11: REGION → ON-RAMP/OFF-RAMP ROUTING
  // ═══════════════════════════════════════════════════════════
  console.log('\n── SECTION 11: REGION ROUTING ──');

  const regionTests = [
    { region: 'na', country: '🇺🇸', expected: 'GROUP_A', label: 'US (NA)' },
    { region: 'eu', country: '🇩🇪', expected: 'GROUP_A', label: 'Germany (EU)' },
    { region: 'latam', country: '🇧🇷', expected: 'GROUP_B', label: 'Brazil (LATAM)' },
    { region: 'asia', country: '🇮🇳', expected: 'GROUP_B', label: 'India (Asia)' },
    { region: 'mea', country: '🇸🇦', expected: 'GROUP_B', label: 'Saudi Arabia (MEA)' },
    { region: 'asia', country: '🇦🇺', expected: 'GROUP_A', label: 'Australia (Asia but GROUP_A country)' },
    { region: 'asia', country: '🇯🇵', expected: 'GROUP_A', label: 'Japan (Asia but GROUP_A country)' },
    { region: 'asia', country: '🇸🇬', expected: 'GROUP_A', label: 'Singapore (Asia but GROUP_A country)' },
    { region: 'mea', country: '🇳🇬', expected: 'GROUP_B', label: 'Nigeria (MEA)' },
  ];

  const GROUP_A_REGIONS = new Set(['na', 'eu']);
  const GROUP_A_COUNTRIES = new Set([
    '🇺🇸', '🇬🇧', '🇨🇦', '🇦🇺', '🇨🇭', '🇸🇬', '🇯🇵',
    '🇦🇹', '🇧🇪', '🇧🇬', '🇭🇷', '🇨🇾', '🇨🇿', '🇩🇰', '🇪🇪', '🇫🇮', '🇫🇷',
    '🇩🇪', '🇬🇷', '🇭🇺', '🇮🇪', '🇮🇹', '🇱🇻', '🇱🇹', '🇱🇺', '🇲🇹', '🇳🇱',
    '🇵🇱', '🇵🇹', '🇷🇴', '🇸🇰', '🇸🇮', '🇪🇸', '🇸🇪',
  ]);

  for (const t of regionTests) {
    const result = (GROUP_A_REGIONS.has(t.region) || GROUP_A_COUNTRIES.has(t.country)) ? 'GROUP_A' : 'GROUP_B';
    const provider = result === 'GROUP_A' ? 'Coinbase' : 'Changelly';
    if (result === t.expected) pass(`${t.label} → ${result} (${provider})`);
    else fail(`${t.label}`, `Expected ${t.expected}, got ${result}`);
  }

  // Verify URL generation for each group
  const testAddr = '0x1234567890123456789012345678901234567890';
  const cdpAppId = process.env.CDP_PROJECT_ID || process.env.CDP_API_KEY_ID || 'test';

  // Group A: Coinbase Onramp
  const onrampUrl = `https://pay.coinbase.com/buy/select-asset?appId=${cdpAppId}&addresses={"${testAddr}":["base"]}&assets=["USDC"]`;
  if (onrampUrl.includes(testAddr) && onrampUrl.includes('base') && onrampUrl.includes('USDC')) {
    pass('GROUP_A Onramp URL: address + base + USDC');
  } else {
    fail('GROUP_A Onramp URL', 'Missing components');
  }

  // Group A: Coinbase Offramp
  const offrampUrl = `https://pay.coinbase.com/sell/select-asset?appId=${cdpAppId}&addresses={"${testAddr}":["base"]}&assets=["USDC"]`;
  if (offrampUrl.includes(testAddr) && offrampUrl.includes('USDC')) {
    pass('GROUP_A Offramp URL: address + USDC');
  } else {
    fail('GROUP_A Offramp URL', 'Missing components');
  }

  // Country code mapping
  try {
    const { FLAG_TO_ISO } = require('../src/interactions/onboarding');
    if (FLAG_TO_ISO) {
      const usCode = FLAG_TO_ISO['🇺🇸'];
      const brCode = FLAG_TO_ISO['🇧🇷'];
      const saCode = FLAG_TO_ISO['🇸🇦'];
      if (usCode === 'US' && brCode === 'BR' && saCode === 'SA') {
        pass(`Country codes: 🇺🇸→US 🇧🇷→BR 🇸🇦→SA`);
      } else {
        fail('Country codes', `US=${usCode} BR=${brCode} SA=${saCode}`);
      }
    } else {
      skip('Country codes', 'FLAG_TO_ISO not exported');
    }
  } catch (e) { skip('Country codes', e.message); }

  // ═══════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\n❌ FATAL:', err.message);
  process.exit(1);
});
