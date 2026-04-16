#!/usr/bin/env node
/* eslint-disable no-console */
// Balance reconciliation diagnostic (read-only).
//
// For every activated wallet:
//   1. Fetch the on-chain USDC balance
//   2. Read the DB balance_available + balance_held
//   3. Reconstruct the "expected" balance from the full transaction
//      history (deposits − escrow_in + disbursement − withdrawal)
//   4. For any wallet where DB != on-chain OR DB != history-derived,
//      emit a probable-cause analysis
//
// Also flags orphan holds: rows in challenge_players where
// funds_held = 1 but the associated challenge/match is in a terminal
// state (completed/cancelled/expired). Those are DB-locked USDC that
// should have been released back to balance_available.
//
// READ-ONLY. Writes nothing. Sends no transactions. Safe to run
// against production.
//
// Usage:
//   node scripts/diagnose-balances.js
//   node scripts/diagnose-balances.js --only <discord_id>   # single user

require('dotenv').config();
const db = require('../src/database/db');
const walletRepo = require('../src/database/repositories/walletRepo');
const walletManager = require('../src/base/walletManager');
const { USDC_PER_UNIT } = require('../src/config/constants');

const onlyDiscordId = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const usdcFmt = (units) => {
  const n = BigInt(units);
  const whole = n / 1_000_000n;
  const frac = (n < 0n ? -n : n) % 1_000_000n;
  const sign = n < 0n ? '-' : '';
  return `${sign}$${whole < 0n ? -whole : whole}.${String(frac).padStart(6, '0').slice(0, 2)}`;
};

function sumUnits(rows) {
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount_usdc || '0');
  return total;
}

async function main() {
  console.log('Balance Reconciliation Diagnostic');
  console.log('='.repeat(72));

  let wallets = walletRepo.getAllActivated();
  if (onlyDiscordId) {
    wallets = wallets.filter(w => {
      const u = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(w.user_id);
      return u?.discord_id === onlyDiscordId;
    });
    console.log(`Filter: only discord_id=${onlyDiscordId} (${wallets.length} wallet[s])`);
  } else {
    console.log(`Activated wallets: ${wallets.length}`);
  }
  console.log('');

  const findUser = db.prepare('SELECT id, discord_id, server_username FROM users WHERE id = ?');
  const findTxByUser = db.prepare(`
    SELECT id, type, amount_usdc, tx_hash, status, memo, created_at, challenge_id
    FROM transactions
    WHERE user_id = ?
    ORDER BY id ASC
  `);
  const findHeldPlayers = db.prepare(`
    SELECT cp.challenge_id, cp.team, cp.role, cp.status as player_status,
           c.status as challenge_status, c.type as challenge_type,
           c.entry_amount_usdc, c.total_pot_usdc
    FROM challenge_players cp
    JOIN challenges c ON c.id = cp.challenge_id
    WHERE cp.user_id = ? AND cp.funds_held = 1
  `);

  const mismatches = [];
  const orphanHolds = [];
  let healthy = 0;

  for (const w of wallets) {
    const user = findUser.get(w.user_id);
    const label = user?.server_username || user?.discord_id || `user_${w.user_id}`;

    let onChain;
    try {
      onChain = BigInt(await walletManager.getUsdcBalance(w.address));
    } catch (err) {
      console.error(`[ERROR] ${label}: failed to read on-chain balance: ${err.message}`);
      continue;
    }

    const avail = BigInt(w.balance_available);
    const held = BigInt(w.balance_held);
    const dbTotal = avail + held;

    // Reconstruct expected balance from transaction history.
    //   + deposit          (on-chain USDC arrived)
    //   + disbursement     (escrow sent winnings back to this wallet)
    //   + release          (DB-only; no on-chain effect, DO NOT count)
    //   + dispute_hold_credit (DB-only)
    //   - escrow_in        (USDC left this wallet into escrow contract)
    //   - withdrawal       (user withdrew to external)
    //   - hold             (DB-only; no on-chain effect, DO NOT count)
    const txs = findTxByUser.all(w.user_id);
    let onChainExpected = 0n;
    const byType = {};
    for (const t of txs) {
      if (t.status && t.status === 'failed') continue;
      byType[t.type] = (byType[t.type] || 0n) + BigInt(t.amount_usdc || '0');
      switch (t.type) {
        case 'deposit':
        case 'disbursement':
          onChainExpected += BigInt(t.amount_usdc || '0');
          break;
        case 'escrow_in':
        case 'withdrawal':
          onChainExpected -= BigInt(t.amount_usdc || '0');
          break;
        // hold / release / dispute_hold_credit are DB-only
        default:
          break;
      }
    }

    const onChainDiff = onChain - onChainExpected;       // reality vs what we'd expect from our tx log
    const dbDiff = onChain - dbTotal;                    // reality vs what we've got in the wallet balances
    const logVsDbDiff = onChainExpected - dbTotal;       // what our log says vs what's sitting in balance cols

    const heldPlayers = findHeldPlayers.all(w.user_id);
    const orphansForThisUser = heldPlayers.filter(hp =>
      ['completed', 'cancelled', 'expired', 'disputed'].includes(hp.challenge_status)
    );
    if (orphansForThisUser.length > 0) {
      orphanHolds.push({ wallet: w, user, orphans: orphansForThisUser });
    }

    const healthyWallet = dbDiff === 0n && logVsDbDiff === 0n && orphansForThisUser.length === 0;

    if (healthyWallet) {
      healthy++;
      continue;
    }

    mismatches.push({ wallet: w, user, onChain, avail, held, dbTotal, onChainExpected, onChainDiff, dbDiff, logVsDbDiff, byType, txs, orphans: orphansForThisUser });
  }

  console.log(`Healthy wallets (DB == on-chain == tx-log, no orphan holds): ${healthy}/${wallets.length}`);
  console.log(`Wallets with discrepancies: ${mismatches.length}`);
  console.log(`Wallets with orphan holds:  ${orphanHolds.length}`);
  console.log('');

  if (mismatches.length === 0 && orphanHolds.length === 0) {
    console.log('All wallets clean. No discrepancies.');
    process.exit(0);
  }

  for (const m of mismatches) {
    const label = m.user?.server_username || m.user?.discord_id || `user_${m.wallet.user_id}`;
    console.log('-'.repeat(72));
    console.log(`${label}  (discord=${m.user?.discord_id || '?'}, wallet=${m.wallet.address})`);
    console.log(`  on-chain USDC:     ${usdcFmt(m.onChain)}   (${m.onChain.toString()} units)`);
    console.log(`  DB avail + held:   ${usdcFmt(m.dbTotal)}  (avail=${usdcFmt(m.avail)}, held=${usdcFmt(m.held)})`);
    console.log(`  Tx-log implies:    ${usdcFmt(m.onChainExpected)}  (deposits − escrow_in + disburse − withdraw)`);
    console.log('');
    console.log('  Diffs:');
    console.log(`    on-chain vs DB:       ${m.dbDiff >= 0n ? '+' : ''}${usdcFmt(m.dbDiff)}   ← this is what the reconciliation service alerts on`);
    console.log(`    on-chain vs tx-log:   ${m.onChainDiff >= 0n ? '+' : ''}${usdcFmt(m.onChainDiff)}`);
    console.log(`    tx-log vs DB:         ${m.logVsDbDiff >= 0n ? '+' : ''}${usdcFmt(m.logVsDbDiff)}`);
    console.log('');
    console.log('  Transaction sums by type:');
    for (const [t, amt] of Object.entries(m.byType)) {
      console.log(`    ${t.padEnd(22)} ${usdcFmt(amt)}  (${amt.toString()} units)`);
    }
    console.log('');
    console.log('  Probable cause:');
    if (m.onChainDiff > 0n) {
      console.log(`    ★ On-chain has ${usdcFmt(m.onChainDiff)} MORE than our tx log accounts for.`);
      console.log('      → Someone sent USDC to this wallet outside the bot (direct transfer,');
      console.log('        test script like fund-and-test.js, or a deposit the poller never saw).');
    } else if (m.onChainDiff < 0n) {
      console.log(`    ★ On-chain has ${usdcFmt(m.onChainDiff)} LESS than our tx log accounts for.`);
      console.log('      → USDC left this wallet outside the bot (direct transfer, test script,');
      console.log('        or an on-chain escrow/withdrawal that WAS recorded but the tx failed');
      console.log('        without the status being updated to failed).');
    }
    if (m.logVsDbDiff !== 0n) {
      console.log(`    ★ Tx log implies ${usdcFmt(m.onChainExpected)} but wallet columns say ${usdcFmt(m.dbTotal)}.`);
      if (m.logVsDbDiff > 0n) {
        console.log('      → Possible missing credit in DB: a deposit / disbursement happened');
        console.log('        on-chain AND was logged, but balance_available never got the +=.');
      } else {
        console.log('      → Possible missing debit: DB was credited (e.g. a deposit was logged)');
        console.log('        but the on-chain money already left via an unlogged withdrawal.');
      }
    }
    if (m.orphans.length > 0) {
      console.log(`    ★ ${m.orphans.length} orphan hold(s) — funds_held=1 on a finished challenge.`);
      for (const o of m.orphans) {
        console.log(`       challenge #${o.challenge_id} (${o.challenge_type}, status=${o.challenge_status}) entry=${usdcFmt(o.entry_amount_usdc || '0')}`);
      }
      console.log('      → balance_held includes USDC for a match that ended without the');
      console.log('        release/disburse flow completing properly.');
    }
    console.log('');
  }

  // Orphan holds for otherwise-clean wallets (caught above in the
  // combined mismatch check, but list separately for wallets where
  // only the hold is wrong)
  const orphansOnly = orphanHolds.filter(oh => !mismatches.find(m => m.wallet.user_id === oh.wallet.user_id));
  if (orphansOnly.length > 0) {
    console.log('-'.repeat(72));
    console.log('Wallets with ONLY orphan holds (balances otherwise match):');
    for (const oh of orphansOnly) {
      const label = oh.user?.server_username || oh.user?.discord_id || `user_${oh.wallet.user_id}`;
      console.log(`  ${label}: ${oh.orphans.length} orphan hold(s)`);
      for (const o of oh.orphans) {
        console.log(`    challenge #${o.challenge_id} (${o.challenge_status}) entry=${usdcFmt(o.entry_amount_usdc || '0')}`);
      }
    }
    console.log('');
  }

  console.log('='.repeat(72));
  console.log('Legend:');
  console.log('  on-chain           = USDC balance reported by the Base blockchain');
  console.log('  DB avail + held    = wallet_available + wallet_held columns for this user');
  console.log('  Tx-log implies     = sum(deposits) − sum(escrow_in) + sum(disbursement) − sum(withdrawal)');
  console.log('');
  console.log('A healthy wallet has: on-chain == DB avail+held == tx-log-derived AND no orphan holds.');
  console.log('');
  console.log('If you see "someone sent USDC outside the bot", that is almost certainly one of');
  console.log('the test scripts (fund-and-test, test-full-flow, test-complete-flow, test-escrow-call)');
  console.log('touching the on-chain contract or wallet directly without going through the Discord');
  console.log('flow that would have logged a DB transaction. On mainnet flip, wallets get fresh');
  console.log('addresses (CDP smart accounts differ per-network), so testnet mismatches do not');
  console.log('carry over to mainnet balances — but the DB balance columns DO carry over unless');
  console.log('reset. Run reset-for-mainnet.js before opening to real users.');

  process.exit(0);
}

main().catch(err => {
  console.error('Diagnostic failed:', err);
  process.exit(1);
});
