const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../base/walletManager');

let reconcileInterval = null;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
      const onChainUsdc = BigInt(await walletManager.getUsdcBalance(wallet.solana_address));

      if (onChainUsdc === 0n) continue;

      const available = BigInt(wallet.balance_available);
      const held = BigInt(wallet.balance_held);
      const expected = available + held;

      const diff = onChainUsdc - expected;

      if (diff !== 0n) {
        discrepancies++;
        console.warn(
          `[Reconciliation] DISCREPANCY for wallet ${wallet.solana_address} (user ${wallet.user_id}): ` +
          `on-chain=${onChainUsdc.toString()} USDC units, ` +
          `expected=${expected.toString()} USDC units ` +
          `(available=${available.toString()} + held=${held.toString()}), ` +
          `diff=${diff.toString()} USDC units`
        );

        // Post the discrepancy to the admin transaction feed so admins
        // see it without having to tail logs.
        try {
          const userRepo = require('../database/repositories/userRepo');
          const { postTransaction } = require('../utils/transactionFeed');
          const userRecord = userRepo.findById(wallet.user_id);
          const diffUsdc = (Number(diff) / 1_000_000).toFixed(6);
          postTransaction({
            type: 'balance_mismatch',
            username: userRecord?.server_username,
            discordId: userRecord?.discord_id,
            amount: `${diff > 0n ? '+' : ''}${diffUsdc}`,
            currency: 'USDC',
            toAddress: wallet.solana_address,
            memo: `On-chain ${onChainUsdc.toString()} vs DB ${expected.toString()} (avail ${available.toString()} + held ${held.toString()}) — diff ${diff.toString()} units`,
          });
        } catch (feedErr) {
          console.error('[Reconciliation] Failed to post mismatch to feed:', feedErr.message);
        }
      }
    } catch (err) {
      console.error(
        `[Reconciliation] Error checking wallet ${wallet.solana_address} (user ${wallet.user_id}):`,
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
