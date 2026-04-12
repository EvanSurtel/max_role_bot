const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../solana/walletManager');
const db = require('../database/db');
const { USDC_PER_UNIT, TRANSACTION_TYPE, TIMERS } = require('../config/constants');

let pollInterval = null;
let botClient = null;
// Process-level mutex so two setInterval cycles can't overlap. If a
// cycle runs long (e.g. RPC stalls, many wallets), the next tick sees
// this flag set and skips its run entirely. Without this, two cycles
// running in parallel both snapshot+credit the same deposit and the
// user gets credited twice for the same on-chain event.
let pollInProgress = false;

// Prepared statement for the atomic deposit-credit transaction.
// Lives at module scope so it's compiled once per process.
const _creditDepositStmt = db.prepare(
  'UPDATE wallets SET balance_available = @balanceAvailable, balance_held = @balanceHeld WHERE user_id = @userId',
);
const _findWalletStmt = db.prepare('SELECT * FROM wallets WHERE user_id = ?');

/**
 * Credit a deposit to a wallet inside a DB transaction with a FRESH
 * read of the current balance. This is the fix for the C4 race:
 *
 *   old flow: read wallet snapshot → await on-chain RPC → compute
 *             new balance from STALE snapshot → write back.
 *             A concurrent holdFunds during the await was silently
 *             clobbered because the snapshot no longer reflected
 *             balance_held correctly.
 *
 *   new flow: read wallet FRESH inside the transaction, compute the
 *             delta against the fresh on-chain-minus-fresh-total,
 *             and only credit if the delta is still positive. If
 *             another flow already credited this deposit in the
 *             time between our RPC call and this transaction, the
 *             delta comes back 0 and we no-op — no double-credit.
 *
 * Returns the delta credited in USDC smallest units (as a BigInt),
 * or 0n if no credit was applied.
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
    _creditDepositStmt.run({
      userId,
      balanceAvailable: (freshAvail + delta).toString(),
      balanceHeld: freshHeld.toString(),
    });
    return delta;
  });
  return tx();
}

/**
 * Start the deposit detection polling loop.
 */
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

/**
 * Stop the deposit detection polling loop.
 */
function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[Deposits] Polling stopped');
  }
}

/**
 * Check all wallets for new USDC deposits.
 * Compares on-chain USDC balance to tracked DB balances and records any differences.
 */
async function checkDeposits() {
  // Process mutex — if the previous cycle is still running, skip.
  // Prevents two overlapping cycles from both crediting the same
  // deposit (double-credit) when RPC calls are slow.
  if (pollInProgress) {
    console.warn('[Deposits] Previous cycle still running — skipping this tick');
    return;
  }
  pollInProgress = true;

  try {
    const wallets = walletRepo.getAll();
    if (wallets.length === 0) return;

    for (const wallet of wallets) {
      try {
        // Query Solana for on-chain USDC balance
        const onChainBalance = BigInt(await walletManager.getUsdcBalance(wallet.solana_address));

        // If no USDC token account exists, balance is 0 — skip
        if (onChainBalance === 0n) continue;

        // Cheap early exit using the stale snapshot — if the snapshot
        // already matches on-chain there can't be a new deposit for
        // this wallet, no reason to bother with the transaction.
        const snapshotAvailable = BigInt(wallet.balance_available);
        const snapshotHeld = BigInt(wallet.balance_held);
        const snapshotTotal = snapshotAvailable + snapshotHeld;
        if (onChainBalance <= snapshotTotal) continue;

        // Do the actual credit inside a transaction with a FRESH
        // wallet read. If another flow (withdraw, hold, or a parallel
        // deposit credit) changed the row since our snapshot, the
        // transaction recalculates the delta against the fresh state
        // and applies the correct amount (or no-op if the delta is
        // already 0 after another writer's work).
        const delta = _creditDepositTx(wallet.user_id, onChainBalance);
        if (delta <= 0n) continue;

        // If wallet was not yet activated, activate it now (first deposit)
        if (!wallet.is_activated) {
          walletRepo.activate(wallet.user_id);
          console.log(`[Deposits] Wallet activated for user ${wallet.user_id} (${wallet.solana_address})`);
        }

        // Log the deposit transaction
        const depositUsdc = (Number(delta) / USDC_PER_UNIT).toFixed(2);
        transactionRepo.create({
          type: TRANSACTION_TYPE.DEPOSIT,
          userId: wallet.user_id,
          challengeId: null,
          amountUsdc: delta.toString(),
          solanaTxSignature: null,
          fromAddress: null,
          toAddress: wallet.solana_address,
          status: 'completed',
          memo: `Deposit detected: $${depositUsdc} USDC`,
        });

        // Post to admin transaction feed (also DMs the user automatically
        // — see DM_TYPES in src/utils/transactionFeed.js)
        const { postTransaction } = require('../utils/transactionFeed');
        const userRecord = require('../database/repositories/userRepo').findById(wallet.user_id);
        await postTransaction({ type: 'deposit', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${depositUsdc}`, currency: 'USDC', toAddress: wallet.solana_address, memo: `Deposit detected: $${depositUsdc} USDC` });

        console.log(
          `[Deposits] Detected deposit of $${depositUsdc} USDC (${delta.toString()} units) ` +
          `for user ${wallet.user_id} at ${wallet.solana_address}`
        );
      } catch (err) {
        console.error(
          `[Deposits] Error checking wallet ${wallet.solana_address} (user ${wallet.user_id}):`,
          err.message || err
        );
      }
    }
  } finally {
    pollInProgress = false;
  }
}

module.exports = {
  startPolling,
  stopPolling,
  checkDeposits,
};
