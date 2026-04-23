#!/usr/bin/env node
// Fund migration script: CDP Server Wallet → user's new Coinbase Smart Wallet.
//
// After a user completes /setup on the wallet web surface, their DB
// row flips to wallet_type='coinbase_smart_wallet' with their new
// Smart Wallet address in `smart_wallet_address`. But any USDC they
// previously deposited lives in the legacy CDP Server Wallet at
// `wallet.address` — we need to sweep that balance to the new wallet
// so the user sees their funds at the self-custody address.
//
// This script uses the bot's existing gasless transferUsdc path (the
// Server Wallet is still the CDP-managed one we can sign from) to send
// the entire available on-chain USDC balance from the legacy address
// to the user's smart_wallet_address.
//
// Usage:
//   node scripts/migrate-funds-to-smart-wallet.js --dry-run
//   node scripts/migrate-funds-to-smart-wallet.js --user <discord_id>
//   node scripts/migrate-funds-to-smart-wallet.js --all
//
// Options:
//   --dry-run      Print the plan, don't submit any transactions.
//   --user <id>    Migrate just one user by Discord ID.
//   --all          Migrate every eligible user in the DB.
//   --min <usdc>   Skip legacy balances below this (USDC, default 0.01).
//
// Eligibility:
//   - wallet_type = 'coinbase_smart_wallet'
//   - smart_wallet_address is non-null and != wallet.address
//   - migrated_at set (so we know setup completed)
//   - on-chain USDC balance at wallet.address >= --min
//   - no active match hold on the user (balance_held == 0)

require('dotenv').config();

const { ethers } = require('ethers');
const db = require('../src/database/db');
const { getProvider } = require('../src/base/connection');
const transactionService = require('../src/base/transactionService');
const walletRepo = require('../src/database/repositories/walletRepo');

const USDC_CONTRACT = (process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913').toLowerCase();
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { dryRun: false, user: null, all: false, minUsd: 0.01 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--all') out.all = true;
    else if (a === '--user') out.user = args[++i];
    else if (a === '--min') out.minUsd = Number(args[++i]);
  }
  if (!out.all && !out.user) {
    console.error('Must specify --user <discord_id> or --all');
    process.exit(2);
  }
  return out;
}

function eligibleRows(opts) {
  // Post-migration wallet.address now equals smart_wallet_address (so
  // deposits route to self-custody), and the original CDP Server Wallet
  // address is preserved in legacy_cdp_address. We sweep FROM that.
  const rows = db.prepare(`
    SELECT
      u.id AS user_id,
      u.discord_id,
      u.server_username,
      w.legacy_cdp_address AS legacy_address,
      w.smart_wallet_address,
      w.wallet_type,
      w.account_ref,
      w.smart_account_ref,
      w.balance_held
    FROM wallets w
    JOIN users u ON u.id = w.user_id
    WHERE w.wallet_type = 'coinbase_smart_wallet'
      AND w.smart_wallet_address IS NOT NULL
      AND w.legacy_cdp_address IS NOT NULL
      AND w.migrated_at IS NOT NULL
  `).all();

  if (opts.user) {
    return rows.filter(r => String(r.discord_id) === String(opts.user));
  }
  return rows;
}

async function run() {
  const opts = parseArgs();
  const rows = eligibleRows(opts);

  if (rows.length === 0) {
    console.log('No eligible users found.');
    return;
  }

  const provider = getProvider();
  const usdc = new ethers.Contract(USDC_CONTRACT, USDC_ABI, provider);
  const minSmallest = BigInt(Math.floor(opts.minUsd * 1e6));

  console.log(`Found ${rows.length} candidate(s). Dry-run: ${opts.dryRun}. Min: $${opts.minUsd}`);

  let swept = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of rows) {
    const label = `[user ${r.user_id} / ${r.discord_id} ${r.server_username || ''}]`;
    try {
      if (BigInt(r.balance_held || 0) > 0n) {
        console.log(`${label} skip — has held balance (active match)`);
        skipped++;
        continue;
      }

      const balance = await usdc.balanceOf(r.legacy_address);
      if (balance < minSmallest) {
        console.log(`${label} skip — legacy balance $${Number(balance) / 1e6} below min`);
        skipped++;
        continue;
      }

      const amountUsd = Number(balance) / 1e6;
      console.log(
        `${label} sweep $${amountUsd.toFixed(6)} ` +
        `from ${r.legacy_address} → ${r.smart_wallet_address}`,
      );

      if (opts.dryRun) {
        continue;
      }

      // Acquire wallet lock so the deposit poller doesn't race with
      // the sweep. The lock column is already in walletRepo API from
      // the legacy path; reuse it here for consistency.
      const locked = walletRepo.acquireLock(r.user_id);
      if (!locked) {
        console.log(`${label} skip — wallet currently locked by another op`);
        skipped++;
        continue;
      }

      try {
        const res = await transactionService.transferUsdc(
          r.legacy_address,
          r.smart_wallet_address,
          balance,
          {
            ownerRef: r.account_ref,
            smartRef: r.smart_account_ref,
          },
        );
        console.log(`${label} swept — tx ${res.hash}`);
        swept++;
      } finally {
        walletRepo.releaseLock(r.user_id);
      }
    } catch (err) {
      console.error(`${label} FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. swept=${swept} skipped=${skipped} failed=${failed}`);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('Fatal:', err);
    process.exit(1);
  },
);
