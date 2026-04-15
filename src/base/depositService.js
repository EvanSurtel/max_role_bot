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

let pollInterval = null;
let botClient = null;
let pollInProgress = false;

// Prepared statements for the atomic deposit credit
const _findWalletStmt = db.prepare('SELECT * FROM wallets WHERE user_id = ?');
const _creditStmt = db.prepare(
  'UPDATE wallets SET balance_available = @balanceAvailable, balance_held = @balanceHeld WHERE user_id = @userId',
);

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
        // Query Base for on-chain USDC balance
        const onChainBalance = BigInt(
          await walletManager.getUsdcBalance(wallet.address),
        );

        if (onChainBalance === 0n) continue;

        // Quick check against stale snapshot
        const snapshotAvail = BigInt(wallet.balance_available);
        const snapshotHeld = BigInt(wallet.balance_held);
        if (onChainBalance <= snapshotAvail + snapshotHeld) continue;

        // Atomic credit with fresh DB read
        const delta = _creditDepositTx(wallet.user_id, onChainBalance);
        if (delta <= 0n) continue;

        if (!wallet.is_activated) {
          walletRepo.activate(wallet.user_id);
        }

        const depositUsdc = (Number(delta) / USDC_PER_UNIT).toFixed(2);
        transactionRepo.create({
          type: TRANSACTION_TYPE.DEPOSIT,
          userId: wallet.user_id,
          challengeId: null,
          amountUsdc: delta.toString(),
          txHash: null,
          fromAddress: null,
          toAddress: wallet.address,
          status: 'completed',
          memo: `Deposit detected: $${depositUsdc} USDC`,
        });

        const { postTransaction } = require('../utils/transactionFeed');
        const userRecord = require('../database/repositories/userRepo').findById(wallet.user_id);
        await postTransaction({
          type: 'deposit',
          username: userRecord?.server_username,
          discordId: userRecord?.discord_id,
          amount: `$${depositUsdc}`,
          currency: 'USDC',
          toAddress: wallet.address,
          memo: `Deposit detected: $${depositUsdc} USDC`,
        });

        console.log(
          `[Deposits] Detected deposit of $${depositUsdc} USDC (${delta} units) ` +
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
