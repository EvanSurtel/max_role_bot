// Base deposit detection service.
//
// Polls each user wallet's USDC balance on Base every 30 seconds and
// credits any increases to their DB available_balance. Same logic as
// the Solana version but using ERC-20 balanceOf calls on the Base
// USDC contract.
//
// The bot doesn't know or care HOW the user got their USDC — whether
// they used Coinbase Onramp (Group A), Changelly (Group B), or
// sent it from any other wallet. It just watches for the balance to
// go up.

const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const db = require('../database/db');
const { USDC_PER_UNIT, TRANSACTION_TYPE, TIMERS } = require('../config/constants');

const MIN_DEPOSIT_UNITS = 10_000; // $0.01 USDC — ignore dust below this

let pollInterval = null;
let botClient = null;
let pollInProgress = false;

// Prepared statements for the atomic deposit credit
const _findWalletStmt = db.prepare('SELECT * FROM wallets WHERE user_id = ?');
const _creditStmt = db.prepare(
  'UPDATE wallets SET balance_available = @balanceAvailable, balance_held = @balanceHeld WHERE user_id = @userId',
);

/**
 * Given a delta the poller detected and a list of pending_onchain
 * inflow rows for the same user, try to match them up.
 *
 * Returns:
 *   {
 *     fullyReconciled: bool    — delta == sum of matched rows exactly
 *     partiallyReconciled: bool — some rows matched but delta != sum
 *     matchedRows: [rows]       — rows explained by the delta
 *     residual: BigInt          — USDC still unaccounted for (delta − sum)
 *   }
 *
 * Matching is greedy: walks rows oldest-first, includes a row if
 * adding it doesn't push the running total past the delta. This
 * works for the common case (single pending inflow equals the
 * delta) and the multi-winner case (several winners of the same
 * match all getting their share paid in the same on-chain tx).
 */
function _reconcilePendingInflows(delta, pendingRows) {
  if (!pendingRows || pendingRows.length === 0) {
    return { fullyReconciled: false, partiallyReconciled: false, matchedRows: [], residual: delta };
  }

  let running = 0n;
  const matched = [];
  for (const row of pendingRows) {
    const amt = BigInt(row.amount_usdc || '0');
    if (running + amt <= delta) {
      matched.push(row);
      running += amt;
      if (running === delta) break;
    }
  }

  const residual = delta - running;
  return {
    fullyReconciled: residual === 0n && matched.length > 0,
    partiallyReconciled: residual > 0n && matched.length > 0,
    matchedRows: matched,
    residual,
  };
}

/**
 * Credit a deposit atomically with a fresh DB read.
 * Returns the delta credited (BigInt), or 0n if nothing to credit.
 */
function _creditDepositTx(userId, observedOnChain) {
  const tx = db.transaction(() => {
    const fresh = _findWalletStmt.get(userId);
    if (!fresh) return 0n;
    const freshAvail = BigInt(fresh.balance_available);
    const freshHeld = BigInt(fresh.balance_held);
    const freshTotal = freshAvail + freshHeld;
    const delta = observedOnChain - freshTotal;
    if (delta <= 0n) return 0n;
    _creditStmt.run({
      userId,
      balanceAvailable: (freshAvail + delta).toString(),
      balanceHeld: freshHeld.toString(),
    });
    return delta;
  });
  return tx();
}

function startPolling(client = null) {
  if (client) botClient = client;
  if (pollInterval) {
    console.warn('[Deposits] Polling already running');
    return;
  }

  console.log(`[Deposits] Starting deposit polling (every ${TIMERS.DEPOSIT_POLL_INTERVAL / 1000}s)`);

  checkDeposits().catch(err => {
    console.error('[Deposits] Error during initial deposit check:', err);
  });

  pollInterval = setInterval(() => {
    checkDeposits().catch(err => {
      console.error('[Deposits] Error during deposit poll cycle:', err);
    });
  }, TIMERS.DEPOSIT_POLL_INTERVAL);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[Deposits] Polling stopped');
  }
}

async function checkDeposits() {
  if (pollInProgress) {
    console.warn('[Deposits] Previous cycle still running — skipping');
    return;
  }
  pollInProgress = true;

  try {
    const wallets = walletRepo.getAll();
    if (wallets.length === 0) return;

    for (const wallet of wallets) {
      try {
        // Skip wallets with an active lock — a withdrawal or other
        // balance-mutating operation is in progress. If we read the
        // on-chain balance now, it might reflect pre-withdrawal state
        // while the DB was already debited (debit-before-send pattern).
        // Crediting the delta as a "deposit" would phantom-credit the
        // user. Safer to skip and catch it on the next poll cycle.
        // (Lock state moved from wallets.locked_at to in-memory
        // walletRepo.isLocked() to fix the new-user-no-wallet-row
        // signup recovery path; the SQL column is no longer used.)
        if (walletRepo.isLocked(wallet.user_id)) continue;

        // Query Base for on-chain USDC balance
        const onChainBalance = BigInt(
          await walletManager.getUsdcBalance(wallet.address),
        );

        const snapshotAvail = BigInt(wallet.balance_available);
        const snapshotHeld = BigInt(wallet.balance_held);

        // Bi-directional reconciliation. Self-custody users own their
        // own wallet, so they can move USDC out of it at any time:
        //   - the `/withdraw` web flow (user-signed USDC.transfer)
        //   - any external transfer from Coinbase Wallet or elsewhere
        // The bot doesn't see these outflows live. If on-chain balance
        // dropped below the DB snapshot, sync DB down to match reality.
        // Without this, `balance_available` stays inflated and
        // `canAfford()` greenlights match entries the user can no
        // longer fund — which would later revert inside the atomic
        // match-start UserOp.
        //
        // The wallet-lock check above (line 144) already skips this
        // branch during an in-flight match deposit where balance_held
        // is mid-update, so this can't race the debit-before-send
        // pattern for on-chain outflows the bot itself initiated.
        if (onChainBalance < snapshotAvail) {
          const newAvail = onChainBalance.toString();
          walletRepo.updateBalance(wallet.user_id, {
            balanceAvailable: newAvail,
            balanceHeld: snapshotHeld.toString(),
          });
          console.log(
            `[Deposits] User ${wallet.user_id} on-chain drop detected: ` +
            `balance_available ${snapshotAvail.toString()} → ${newAvail} ` +
            `(on-chain ${onChainBalance.toString()}, external withdraw/transfer)`,
          );
          continue;
        }

        if (onChainBalance === 0n) continue;

        // Quick check against stale snapshot
        if (onChainBalance <= snapshotAvail + snapshotHeld) continue;

        // Skip dust deposits — anything below $0.01 USDC is ignored
        const snapshotDelta = onChainBalance - (snapshotAvail + snapshotHeld);
        if (snapshotDelta < BigInt(MIN_DEPOSIT_UNITS)) continue;

        // Atomic credit with fresh DB read. Returns the delta that
        // was applied (already += to balance_available).
        const delta = _creditDepositTx(wallet.user_id, onChainBalance);
        if (delta <= 0n) continue;

        if (!wallet.is_activated) {
          walletRepo.activate(wallet.user_id);
        }

        // Before labeling this delta as a fresh DEPOSIT, check whether
        // it's actually a partially-applied INFLOW from the bot itself
        // (match disbursement, cancel refund, or dispute-hold credit)
        // where the on-chain tx landed but the DB credit failed. In
        // that case the escrowManager left a pending_onchain row we
        // can reconcile to instead of double-logging.
        const pendingInflows = transactionRepo.findPendingInflowsForUser(wallet.user_id, 5400);
        const reconciled = _reconcilePendingInflows(delta, pendingInflows);

        const usdcFmt = (Number(delta) / USDC_PER_UNIT).toFixed(2);
        const userRecord = require('../database/repositories/userRepo').findById(wallet.user_id);
        const { postTransaction } = require('../utils/transactionFeed');

        if (reconciled.fullyReconciled) {
          // Entire delta explained by one-or-more pending_onchain
          // disbursement/refund rows. Flip them to completed and
          // DON'T log a duplicate DEPOSIT. Admin feed gets a
          // RECONCILED post so you can see what happened.
          for (const row of reconciled.matchedRows) {
            const newStatus = row.type === TRANSACTION_TYPE.DISPUTE_HOLD_CREDIT ? 'pending_release' : 'completed';
            transactionRepo.updateStatusAndHash(
              row.id,
              newStatus,
              row.tx_hash,
              `${row.memo || ''} — reconciled by poller`,
            );
          }

          await postTransaction({
            type: 'reconciled_inflow',
            username: userRecord?.server_username,
            discordId: userRecord?.discord_id,
            amount: `$${usdcFmt}`,
            currency: 'USDC',
            toAddress: wallet.address,
            memo: `Reconciled $${usdcFmt} USDC to ${reconciled.matchedRows.length} pending ${reconciled.matchedRows.map(r => r.type).join('/')} row(s). On-chain tx arrived after DB credit path failed — now consistent.`,
          });

          console.log(`[Deposits] Reconciled $${usdcFmt} USDC (${delta} units) for user ${wallet.user_id} against ${reconciled.matchedRows.length} pending inflow(s)`);
          continue;
        }

        if (reconciled.partiallyReconciled) {
          // We matched some but not all. Flip the matched ones, log
          // the remainder as DEPOSIT with a flag.
          for (const row of reconciled.matchedRows) {
            const newStatus = row.type === TRANSACTION_TYPE.DISPUTE_HOLD_CREDIT ? 'pending_release' : 'completed';
            transactionRepo.updateStatusAndHash(
              row.id,
              newStatus,
              row.tx_hash,
              `${row.memo || ''} — reconciled by poller (partial)`,
            );
          }
        }

        const residual = reconciled.residual;
        const residualUsdc = (Number(residual) / USDC_PER_UNIT).toFixed(2);

        // Anything left over = genuine external deposit (or something
        // we can't account for — flagged for review).
        transactionRepo.create({
          type: TRANSACTION_TYPE.DEPOSIT,
          userId: wallet.user_id,
          challengeId: null,
          amountUsdc: residual.toString(),
          txHash: null,
          fromAddress: null,
          toAddress: wallet.address,
          status: 'completed',
          memo: reconciled.partiallyReconciled
            ? `Deposit detected: $${residualUsdc} USDC (remaining after reconciling pending inflows)`
            : `Deposit detected: $${residualUsdc} USDC (no matching pending inflow — external source)`,
        });

        await postTransaction({
          type: 'deposit',
          username: userRecord?.server_username,
          discordId: userRecord?.discord_id,
          amount: `$${residualUsdc}`,
          currency: 'USDC',
          toAddress: wallet.address,
          memo: reconciled.partiallyReconciled
            ? `Deposit (residual after reconciliation): $${residualUsdc} USDC`
            : `Deposit: $${residualUsdc} USDC — external source (no matching pending inflow in last 90 min)`,
        });

        console.log(
          `[Deposits] Detected ${reconciled.partiallyReconciled ? 'residual ' : ''}deposit of $${residualUsdc} USDC (${residual} units) ` +
          `for user ${wallet.user_id} at ${wallet.address}`,
        );
      } catch (err) {
        console.error(
          `[Deposits] Error checking wallet ${wallet.address} (user ${wallet.user_id}):`,
          err.message || err,
        );
      }
    }
  } finally {
    pollInProgress = false;
  }
}

module.exports = { startPolling, stopPolling, checkDeposits };
