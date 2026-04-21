// Periodic on-chain vs DB balance reconciliation (every 5 min).
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../base/walletManager');
const transactionRepo = require('../database/repositories/transactionRepo');

let reconcileInterval = null;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Ignore mismatches smaller than $0.01 (same floor used by the deposit
// poller). Rounding errors in the 6th decimal shouldn't fire alerts.
const DUST_UNITS = 10_000n;

/**
 * Run a one-time reconciliation of all activated wallets.
 * Compares on-chain USDC balances to DB balances and logs discrepancies.
 */
async function reconcileAll() {
  const wallets = walletRepo.getAllActivated();

  if (wallets.length === 0) {
    console.log('[Reconciliation] No activated wallets to check');
    return;
  }

  let discrepancies = 0;

  for (const wallet of wallets) {
    try {
      const onChainUsdc = BigInt(await walletManager.getUsdcBalance(wallet.address));

      if (onChainUsdc === 0n) continue;

      const available = BigInt(wallet.balance_available);
      const held = BigInt(wallet.balance_held);
      const expected = available + held;

      const diff = onChainUsdc - expected;

      // Factor in in-flight transactions before alerting. Without
      // this, every mid-withdraw cycle fires a false alarm:
      //  - Pending OUT (withdrawal): DB debited already, on-chain
      //    hasn't decremented yet → on_chain > DB by pending amount.
      //  - Pending IN (disbursement/refund/dispute_hold_credit): bot
      //    pre-logged intent but hasn't credited DB yet; on-chain
      //    may already be higher → on_chain > DB by pending amount.
      // Either way, on_chain exceeds DB by the sum of pending
      // amounts for this wallet. Subtract that from `diff` before
      // deciding if there's a real discrepancy.
      let pendingOutflowSum = 0n;
      let pendingInflowSum = 0n;
      try {
        for (const row of transactionRepo.findPendingOutflowsForUser(wallet.user_id)) {
          pendingOutflowSum += BigInt(row.amount_usdc || '0');
        }
        for (const row of transactionRepo.findPendingInflowsForUserAll(wallet.user_id)) {
          pendingInflowSum += BigInt(row.amount_usdc || '0');
        }
      } catch (txErr) {
        console.warn(`[Reconciliation] pending-tx lookup failed for user ${wallet.user_id}: ${txErr.message}`);
      }
      const explained = pendingOutflowSum + pendingInflowSum;
      const netDiff = diff - explained;

      if (netDiff > DUST_UNITS || netDiff < -DUST_UNITS) {
        discrepancies++;
        console.warn(
          `[Reconciliation] DISCREPANCY for wallet ${wallet.address} (user ${wallet.user_id}): ` +
          `on-chain=${onChainUsdc.toString()} USDC units, ` +
          `expected=${expected.toString()} USDC units ` +
          `(available=${available.toString()} + held=${held.toString()}), ` +
          `raw_diff=${diff.toString()}, pending_out=${pendingOutflowSum.toString()}, pending_in=${pendingInflowSum.toString()}, ` +
          `net_diff=${netDiff.toString()} USDC units`
        );

        // Post the UNEXPLAINED portion to the admin transaction feed.
        // Log the pending breakdown too so an admin investigating
        // the alert can see whether in-flight tx accounts for some of
        // the diff.
        try {
          const userRepo = require('../database/repositories/userRepo');
          const { postTransaction } = require('../utils/transactionFeed');
          const userRecord = userRepo.findById(wallet.user_id);
          const netDiffUsdc = (Number(netDiff) / 1_000_000).toFixed(6);
          postTransaction({
            type: 'balance_mismatch',
            username: userRecord?.server_username,
            discordId: userRecord?.discord_id,
            amount: `${netDiff > 0n ? '+' : ''}${netDiffUsdc}`,
            currency: 'USDC',
            toAddress: wallet.address,
            memo: `Unexplained after accounting for in-flight tx. on_chain=${onChainUsdc.toString()} DB=${expected.toString()} pending_out=${pendingOutflowSum.toString()} pending_in=${pendingInflowSum.toString()} net_diff=${netDiff.toString()} units`,
          });
        } catch (feedErr) {
          console.error('[Reconciliation] Failed to post mismatch to feed:', feedErr.message);
        }
      } else if (diff !== 0n) {
        // Non-zero raw diff, but fully explained by pending tx.
        // Log only — no alert.
        console.log(
          `[Reconciliation] wallet ${wallet.address} (user ${wallet.user_id}): ` +
          `diff=${diff.toString()} fully explained by pending out=${pendingOutflowSum.toString()} / in=${pendingInflowSum.toString()} — no alert`
        );
      }
    } catch (err) {
      console.error(
        `[Reconciliation] Error checking wallet ${wallet.address} (user ${wallet.user_id}):`,
        err.message || err
      );
    }
  }

  if (discrepancies === 0) {
    console.log(`[Reconciliation] All ${wallets.length} activated wallet(s) reconciled — no discrepancies`);
  } else {
    console.warn(`[Reconciliation] Found ${discrepancies} discrepancy/ies across ${wallets.length} wallet(s)`);
  }
}

/**
 * Start periodic balance reconciliation.
 */
function startReconciliation(intervalMs = DEFAULT_INTERVAL_MS) {
  if (reconcileInterval) {
    console.warn('[Reconciliation] Already running');
    return;
  }

  console.log(`[Reconciliation] Starting periodic reconciliation (every ${intervalMs / 1000}s)`);

  setTimeout(() => {
    reconcileAll().catch(err => {
      console.error('[Reconciliation] Error during initial reconciliation:', err);
    });
  }, 10_000);

  reconcileInterval = setInterval(() => {
    reconcileAll().catch(err => {
      console.error('[Reconciliation] Error during reconciliation cycle:', err);
    });
  }, intervalMs);
}

/**
 * Stop periodic balance reconciliation.
 */
function stopReconciliation() {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    console.log('[Reconciliation] Stopped');
  }
}

module.exports = {
  reconcileAll,
  startReconciliation,
  stopReconciliation,
};
