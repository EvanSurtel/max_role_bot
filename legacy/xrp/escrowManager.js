const xrpl = require('xrpl');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const transactionService = require('./transactionService');
const { XRP_BASE_RESERVE, TRANSACTION_TYPE } = require('../config/constants');

/**
 * Get the escrow wallet derived from the ESCROW_WALLET_SEED env var.
 * @returns {xrpl.Wallet}
 */
function getEscrowWallet() {
  if (!process.env.ESCROW_WALLET_SEED) {
    throw new Error('ESCROW_WALLET_SEED environment variable is not set');
  }
  return xrpl.Wallet.fromSeed(process.env.ESCROW_WALLET_SEED);
}

/**
 * Hold funds for a challenge (DB-only operation).
 * Moves funds from available to held balance in the wallet record.
 * Logs a 'hold' transaction.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountDrops - Amount in drops to hold.
 * @param {number} challengeId - The challenge ID.
 * @returns {boolean} true if the hold succeeded.
 */
function holdFunds(userId, amountDrops, challengeId) {
  try {
    walletRepo.holdFunds(userId, amountDrops);

    const wallet = walletRepo.findByUserId(userId);
    transactionRepo.create({
      type: TRANSACTION_TYPE.HOLD,
      userId,
      challengeId,
      amountDrops: amountDrops.toString(),
      fromAddress: wallet ? wallet.xrp_address : null,
      toAddress: null,
      status: 'completed',
      memo: `Hold for challenge #${challengeId}`,
    });

    console.log(`[Escrow] Held ${amountDrops} drops for user ${userId}, challenge ${challengeId}`);
    return true;
  } catch (err) {
    console.error(`[Escrow] Failed to hold funds for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Release held funds back to available (DB-only operation).
 * Reverses a hold. Logs a 'release' transaction.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountDrops - Amount in drops to release.
 * @param {number} challengeId - The challenge ID.
 * @returns {boolean} true if the release succeeded.
 */
function releaseFunds(userId, amountDrops, challengeId) {
  try {
    walletRepo.releaseFunds(userId, amountDrops);

    const wallet = walletRepo.findByUserId(userId);
    transactionRepo.create({
      type: TRANSACTION_TYPE.RELEASE,
      userId,
      challengeId,
      amountDrops: amountDrops.toString(),
      fromAddress: null,
      toAddress: wallet ? wallet.xrp_address : null,
      status: 'completed',
      memo: `Release for challenge #${challengeId}`,
    });

    console.log(`[Escrow] Released ${amountDrops} drops for user ${userId}, challenge ${challengeId}`);
    return true;
  } catch (err) {
    console.error(`[Escrow] Failed to release funds for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Check if a user can afford a given amount, accounting for the XRP base reserve.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountDrops - Amount in drops to check.
 * @returns {boolean} true if the user has enough available balance.
 */
function canAfford(userId, amountDrops) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) return false;

  const available = BigInt(wallet.balance_available);
  const needed = BigInt(amountDrops) + BigInt(XRP_BASE_RESERVE);

  return available >= needed;
}

/**
 * Transfer XRP from user wallet to escrow wallet on-ledger.
 * Decrypts the user's wallet seed, sends XRP, reduces held balance,
 * and logs an 'escrow_in' transaction with the tx hash.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountDrops - Amount in drops to transfer.
 * @param {number} challengeId - The challenge ID.
 * @returns {Promise<{ txHash: string, result: object }>}
 */
async function transferToEscrow(userId, amountDrops, challengeId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) {
    throw new Error(`No wallet found for user ${userId}`);
  }

  const userWallet = walletManager.getWalletFromSeed(
    walletRecord.encrypted_seed,
    walletRecord.encryption_iv,
    walletRecord.encryption_tag,
  );

  const escrowWallet = getEscrowWallet();

  const { txHash, result } = await transactionService.sendPayment(
    userWallet,
    escrowWallet.address,
    amountDrops,
    `Escrow deposit for challenge #${challengeId}`,
  );

  // Reduce the held balance now that funds are on-ledger in escrow
  walletRepo.releaseFunds(userId, amountDrops);

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN,
    userId,
    challengeId,
    amountDrops: amountDrops.toString(),
    xrplTxHash: txHash,
    fromAddress: userWallet.address,
    toAddress: escrowWallet.address,
    status: 'completed',
    memo: `Escrow transfer for challenge #${challengeId}`,
  });

  console.log(`[Escrow] Transferred ${amountDrops} drops from user ${userId} to escrow. TX: ${txHash}`);
  return { txHash, result };
}

/**
 * Disburse winnings from escrow to winners on-ledger.
 * Calculates per-player share, deducts platform fee, sends XRP from escrow
 * to each winner, and logs all transactions.
 *
 * @param {number} challengeId - The challenge ID.
 * @param {number[]} winningPlayerIds - Array of winning user IDs.
 * @param {string|number} totalPotDrops - Total pot amount in drops.
 * @returns {Promise<{ disbursements: object[], feeTxHash: string }>}
 */
async function disburseWinnings(challengeId, winningPlayerIds, totalPotDrops) {
  if (!winningPlayerIds || winningPlayerIds.length === 0) {
    throw new Error('No winning player IDs provided');
  }

  const escrowWallet = getEscrowWallet();
  const totalPot = BigInt(totalPotDrops);
  const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT || '5');
  const feeAmount = totalPot * BigInt(Math.round(feePercent * 100)) / 10000n;
  const distributableAmount = totalPot - feeAmount;
  const perPlayerShare = distributableAmount / BigInt(winningPlayerIds.length);

  const disbursements = [];

  // Send to each winner
  for (const userId of winningPlayerIds) {
    const walletRecord = walletRepo.findByUserId(userId);
    if (!walletRecord) {
      console.error(`[Escrow] No wallet found for winning user ${userId}, skipping`);
      continue;
    }

    try {
      const { txHash, result } = await transactionService.sendPayment(
        escrowWallet,
        walletRecord.xrp_address,
        perPlayerShare.toString(),
        `Winnings from challenge #${challengeId}`,
      );

      // Update winner's available balance in DB
      const currentAvailable = BigInt(walletRecord.balance_available);
      walletRepo.updateBalance(userId, {
        balanceAvailable: (currentAvailable + perPlayerShare).toString(),
        balanceHeld: walletRecord.balance_held,
      });

      transactionRepo.create({
        type: TRANSACTION_TYPE.DISBURSEMENT,
        userId,
        challengeId,
        amountDrops: perPlayerShare.toString(),
        xrplTxHash: txHash,
        fromAddress: escrowWallet.address,
        toAddress: walletRecord.xrp_address,
        status: 'completed',
        memo: `Winnings for challenge #${challengeId}`,
      });

      disbursements.push({ userId, txHash, amount: perPlayerShare.toString(), result });
      console.log(`[Escrow] Disbursed ${perPlayerShare} drops to user ${userId}. TX: ${txHash}`);
    } catch (err) {
      console.error(`[Escrow] Failed to disburse to user ${userId}:`, err.message);
      disbursements.push({ userId, error: err.message });
    }
  }

  // Log the platform fee transaction (fee stays in escrow wallet)
  let feeTxHash = null;
  if (feeAmount > 0n) {
    transactionRepo.create({
      type: TRANSACTION_TYPE.FEE,
      userId: null,
      challengeId,
      amountDrops: feeAmount.toString(),
      xrplTxHash: null,
      fromAddress: escrowWallet.address,
      toAddress: escrowWallet.address,
      status: 'completed',
      memo: `Platform fee (${feePercent}%) for challenge #${challengeId}`,
    });

    console.log(`[Escrow] Platform fee: ${feeAmount} drops for challenge ${challengeId}`);
  }

  return { disbursements, feeTxHash };
}

/**
 * Refund all held funds for all players in a challenge.
 * Used when a challenge is cancelled.
 *
 * @param {number} challengeId - The challenge ID.
 * @returns {{ refunded: number[], failed: number[] }}
 */
function refundAll(challengeId) {
  const transactions = transactionRepo.findByChallengeId(challengeId);

  // Find all hold transactions for this challenge to determine who has held funds
  const holdsByUser = new Map();
  for (const tx of transactions) {
    if (tx.type === TRANSACTION_TYPE.HOLD && tx.status === 'completed') {
      const current = holdsByUser.get(tx.user_id) || 0n;
      holdsByUser.set(tx.user_id, current + BigInt(tx.amount_drops));
    }
    if (tx.type === TRANSACTION_TYPE.RELEASE && tx.status === 'completed') {
      const current = holdsByUser.get(tx.user_id) || 0n;
      holdsByUser.set(tx.user_id, current - BigInt(tx.amount_drops));
    }
  }

  const refunded = [];
  const failed = [];

  for (const [userId, netHeld] of holdsByUser) {
    if (netHeld <= 0n) continue;

    const success = releaseFunds(userId, netHeld.toString(), challengeId);
    if (success) {
      refunded.push(userId);
    } else {
      failed.push(userId);
    }
  }

  console.log(`[Escrow] Refund for challenge ${challengeId}: ${refunded.length} refunded, ${failed.length} failed`);
  return { refunded, failed };
}

module.exports = {
  holdFunds,
  releaseFunds,
  canAfford,
  transferToEscrow,
  disburseWinnings,
  refundAll,
};
