const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../solana/walletManager');
const { USDC_PER_UNIT, TRANSACTION_TYPE, TIMERS } = require('../config/constants');
const { t } = require('../locales/i18n');

let pollInterval = null;
let botClient = null;

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

      // Post to admin transaction feed
      const { postTransaction } = require('../utils/transactionFeed');
      const userRecord = require('../database/repositories/userRepo').findById(wallet.user_id);
      postTransaction({ type: 'deposit', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${depositUsdc}`, currency: 'USDC', toAddress: wallet.solana_address, memo: `Deposit detected: $${depositUsdc} USDC` });

      console.log(
        `[Deposits] Detected deposit of $${depositUsdc} USDC (${depositAmount.toString()} units) ` +
        `for user ${wallet.user_id} at ${wallet.solana_address}`
      );

      // DM the user so they know their deposit landed. Silent failure if
      // they have DMs from server members disabled — they'll see the
      // updated balance next time they click View My Wallet.
      if (botClient && userRecord?.discord_id) {
        try {
          const discordUser = await botClient.users.fetch(userRecord.discord_id);
          const lang = userRecord.language || 'en';
          await discordUser.send({
            content: t('deposit_dm.received', lang, {
              amount: depositUsdc,
              new_balance: (Number(newAvailable) / USDC_PER_UNIT).toFixed(2),
            }),
          });
        } catch (dmErr) {
          // User probably has DMs disabled — not an error, just log it
          console.log(
            `[Deposits] Could not DM user ${userRecord.discord_id} about deposit (DMs likely disabled): ${dmErr.message}`
          );
        }
      }
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
