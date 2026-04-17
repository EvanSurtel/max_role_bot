#!/usr/bin/env node
/* eslint-disable no-console */
// Emergency admin escape hatch — calls escrow.cancelMatch directly
// from the ORIGINAL EOA using ethers.js (not via the new Smart
// Account UserOp path). Use ONLY if the main resolveMatch /
// cancelMatch flow via Paymaster is broken and funds are stuck in
// escrow.
//
// Why this exists:
//   The bot now routes all admin calls through escrow-owner-smart
//   (a Smart Account, Paymaster-sponsored). If anything in that
//   path fails mid-match — CDP outage, Paymaster policy rejection,
//   Smart Account initCode issue — funds could get locked in the
//   escrow contract with no automated recovery.
//
//   Before ownership was transferred, the EOA `escrow-owner` WAS
//   the owner. After transferOwnership() it's NOT anymore — which
//   means this script will fail with "caller is not the owner"
//   unless you first transfer ownership BACK to the EOA (also
//   admin-only; requires the current owner, i.e. the broken Smart
//   Account, to sign). So this is usable as an escape hatch ONLY
//   BEFORE the ownership transfer has happened, OR if you can
//   successfully run one Smart Account UserOp to hand ownership
//   back to the EOA.
//
//   In practice you should run this IMMEDIATELY after a bad first
//   mainnet test if the Smart Account flow fails — it catches the
//   window where either (a) ownership transfer itself failed, or
//   (b) you paused before starting any matches.
//
// Usage:
//   node scripts/emergency-cancel-match.js <matchId>
//
// Requires:
//   ESCROW_CONTRACT_ADDRESS set in .env
//   escrow-owner EOA has enough ETH for one cancelMatch tx (~$0.05)
//
// NOT A RUNTIME DEPENDENCY — do not call from bot code. This is a
// human-triggered break-glass tool only.

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');
const db = require('../src/database/db');
const challengePlayerRepo = require('../src/database/repositories/challengePlayerRepo');
const walletRepo = require('../src/database/repositories/walletRepo');

const ESCROW_ABI = [
  'function owner() view returns (address)',
  'function cancelMatch(uint256 matchId, address[] players, uint256[] refunds)',
  'function matches(uint256) view returns (uint256 entryAmount, uint8 playerCount, uint8 depositCount, uint256 totalPot, bool resolved, bool cancelled)',
];

async function main() {
  const matchId = parseInt(process.argv[2], 10);
  if (!matchId) {
    console.error('Usage: node scripts/emergency-cancel-match.js <matchId>');
    process.exit(1);
  }

  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const rpcUrl = process.env.BASE_RPC_URL || (network === 'sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org');
  const chainId = network === 'sepolia' ? 84532 : 8453;
  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!escrowAddr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');

  const cdp = new CdpClient();
  const ownerEoa = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  console.log(`[Emergency] Using EOA: ${ownerEoa.address}`);

  // Look up the match + player wallets from the local DB so we can
  // reconstruct the cancelMatch call args.
  const matchRow = db.prepare('SELECT m.*, c.entry_amount_usdc FROM matches m JOIN challenges c ON c.id = m.challenge_id WHERE m.id = ?').get(matchId);
  if (!matchRow) throw new Error(`No match #${matchId} in DB`);

  const players = challengePlayerRepo.findByChallengeId(matchRow.challenge_id);
  const addresses = [];
  const refunds = [];
  for (const p of players) {
    const w = walletRepo.findByUserId(p.user_id);
    if (!w) continue;
    addresses.push(w.address);
    refunds.push(matchRow.entry_amount_usdc);
  }

  console.log(`[Emergency] Match #${matchId}: ${addresses.length} players, entry ${matchRow.entry_amount_usdc} USDC units each`);

  // Connect with the raw EOA private key (ethers.js, bypasses CDP SDK entirely)
  console.log('[Emergency] Exporting EOA private key...');
  const privateKey = await cdp.evm.exportAccount({ address: ownerEoa.address });
  const provider = new ethers.JsonRpcProvider(rpcUrl, { name: network === 'sepolia' ? 'base-sepolia' : 'base', chainId });
  const wallet = new ethers.Wallet(privateKey, provider);

  // Sanity: is the EOA still the contract owner? If not, this script
  // WILL fail with "Ownable: caller is not the owner" and you'll
  // need to recover via the Smart Account (or admin intervention).
  const contract = new ethers.Contract(escrowAddr, ESCROW_ABI, wallet);
  const currentOwner = await contract.owner();
  console.log(`[Emergency] On-chain owner:   ${currentOwner}`);
  console.log(`[Emergency] EOA address:      ${ownerEoa.address}`);
  if (currentOwner.toLowerCase() !== ownerEoa.address.toLowerCase()) {
    console.error('');
    console.error('❌ The EOA is NOT the current on-chain owner.');
    console.error('   cancelMatch will revert. You need to transfer ownership back');
    console.error('   to the EOA first — which requires the current owner (the');
    console.error('   broken Smart Account) to sign. If the Smart Account path is');
    console.error('   fully broken, you are stuck and need to contact Coinbase CDP');
    console.error('   support or manually sign a UserOp outside this bot.');
    console.error('');
    process.exit(1);
  }

  // Check the match state on-chain before trying to cancel
  const onChainMatch = await contract.matches(matchId);
  console.log(`[Emergency] On-chain match state:`);
  console.log(`    entryAmount:  ${onChainMatch.entryAmount}`);
  console.log(`    playerCount:  ${onChainMatch.playerCount}`);
  console.log(`    depositCount: ${onChainMatch.depositCount}`);
  console.log(`    totalPot:     ${onChainMatch.totalPot}`);
  console.log(`    resolved:     ${onChainMatch.resolved}`);
  console.log(`    cancelled:    ${onChainMatch.cancelled}`);

  if (onChainMatch.cancelled) {
    console.log('Match is already cancelled on-chain. Nothing to do.');
    process.exit(0);
  }
  if (onChainMatch.resolved) {
    console.log('Match is already resolved on-chain. Cannot cancel.');
    process.exit(0);
  }

  console.log('');
  console.log('─'.repeat(60));
  console.log('About to cancel. This will refund every deposited player.');
  console.log(`Escrow: ${escrowAddr}`);
  console.log(`Match:  ${matchId}`);
  console.log(`Refund addresses: ${addresses.join(', ')}`);
  console.log(`Refund amounts:   ${refunds.join(', ')}`);
  console.log('─'.repeat(60));
  console.log('');

  // 5 second pause, then go — easier than interactive confirm in a headless run
  await new Promise(r => setTimeout(r, 5000));

  console.log('[Emergency] Sending cancelMatch tx...');
  const tx = await contract.cancelMatch(matchId, addresses, refunds);
  console.log(`[Emergency] TX hash: ${tx.hash}`);
  await tx.wait(1);
  console.log('[Emergency] ✅ Cancelled. Funds refunded to players on-chain.');
  console.log('');
  console.log('IMPORTANT: the bot DB still thinks the match is active. You will');
  console.log('need to manually mark it cancelled and credit each player\'s');
  console.log('balance_available from the pending_onchain refund rows. Or');
  console.log('restart the bot and let the deposit poller / reconciliation');
  console.log('flow catch up.');
}

main().catch(err => {
  console.error('[Emergency] FATAL:', err);
  process.exit(1);
});
