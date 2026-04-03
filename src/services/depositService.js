const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../solana/walletManager');
const { USDC_PER_UNIT, TRANSACTION_TYPE, TIMERS } = require('../config/constants');

let pollInterval = null;

/**
 * Start the deposit detection polling loop.
 */
function startPolling() {
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
  const wallets = walletRepo.getAll();
  if (wallets.length === 0) return;

  for (const wallet of wallets) {
    try {
      // Query Solana for on-chain USDC balance
      const onChainBalance = BigInt(await walletManager.getUsdcBalance(wallet.solana_address));

      // If no USDC token account exists, balance is 0 — skip
      if (onChainBalance === 0n) continue;

      // Calculate expected on-chain balance from our DB records
      const dbAvailable = BigInt(wallet.balance_available);
      const dbHeld = BigInt(wallet.balance_held);
      const expectedOnChain = dbAvailable + dbHeld;

      // If on-chain is higher than expected, we have a new deposit
      const depositAmount = onChainBalance - expectedOnChain;

      if (depositAmount <= 0n) continue;

      // If wallet was not yet activated, activate it now (first deposit)
      if (!wallet.is_activated) {
        walletRepo.activate(wallet.user_id);
        console.log(`[Deposits] Wallet activated for user ${wallet.user_id} (${wallet.solana_address})`);
      }

      // Update the available balance in the DB
      const newAvailable = dbAvailable + depositAmount;
      walletRepo.updateBalance(wallet.user_id, {
        balanceAvailable: newAvailable.toString(),
        balanceHeld: dbHeld.toString(),
      });

      // Log the deposit transaction
      const depositUsdc = (Number(depositAmount) / USDC_PER_UNIT).toFixed(2);
      transactionRepo.create({
        type: TRANSACTION_TYPE.DEPOSIT,
        userId: wallet.user_id,
        challengeId: null,
        amountUsdc: depositAmount.toString(),
        solanaTxSignature: null,
        fromAddress: null,
        toAddress: wallet.solana_address,
        status: 'completed',
        memo: `Deposit detected: $${depositUsdc} USDC`,
      });

      console.log(
        `[Deposits] Detected deposit of $${depositUsdc} USDC (${depositAmount.toString()} units) ` +
        `for user ${wallet.user_id} at ${wallet.solana_address}`
      );
    } catch (err) {
      console.error(
        `[Deposits] Error checking wallet ${wallet.solana_address} (user ${wallet.user_id}):`,
        err.message || err
      );
    }
  }
}

module.exports = {
  startPolling,
  stopPolling,
  checkDeposits,
};
