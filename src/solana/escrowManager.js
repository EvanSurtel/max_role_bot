const { Keypair, PublicKey } = require('@solana/web3.js');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const transactionService = require('./transactionService');
const { TRANSACTION_TYPE, MIN_SOL_FOR_GAS } = require('../config/constants');

/**
 * Get the escrow authority keypair from env var.
 * This is the bot's master wallet that controls the escrow program.
 * @returns {Keypair}
 */
function getEscrowKeypair() {
  const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
  if (!secretKeyJson) {
    throw new Error('ESCROW_WALLET_SECRET environment variable is not set');
  }
  const secretKey = Uint8Array.from(JSON.parse(secretKeyJson));
  return Keypair.fromSecretKey(secretKey);
}

/**
 * Hold funds for a challenge (DB-only operation).
 * Moves USDC from available to held balance in the wallet record.
 * Logs a 'hold' transaction.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountUsdc - Amount in USDC smallest units to hold.
 * @param {number} challengeId - The challenge ID.
 * @returns {boolean} true if the hold succeeded.
 */
function holdFunds(userId, amountUsdc, challengeId) {
  try {
    walletRepo.holdFunds(userId, amountUsdc);

    const wallet = walletRepo.findByUserId(userId);
    transactionRepo.create({
      type: TRANSACTION_TYPE.HOLD,
      userId,
      challengeId,
      amountUsdc: amountUsdc.toString(),
      fromAddress: wallet ? wallet.solana_address : null,
      toAddress: null,
      status: 'completed',
      memo: `Hold for challenge #${challengeId}`,
    });

    console.log(`[Escrow] Held ${amountUsdc} USDC units for user ${userId}, challenge ${challengeId}`);
    return true;
  } catch (err) {
    console.error(`[Escrow] Failed to hold funds for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Release held funds back to available (DB-only operation).
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountUsdc - Amount in USDC smallest units to release.
 * @param {number} challengeId - The challenge ID.
 * @returns {boolean} true if the release succeeded.
 */
function releaseFunds(userId, amountUsdc, challengeId) {
  try {
    walletRepo.releaseFunds(userId, amountUsdc);

    const wallet = walletRepo.findByUserId(userId);
    transactionRepo.create({
      type: TRANSACTION_TYPE.RELEASE,
      userId,
      challengeId,
      amountUsdc: amountUsdc.toString(),
      fromAddress: null,
      toAddress: wallet ? wallet.solana_address : null,
      status: 'completed',
      memo: `Release for challenge #${challengeId}`,
    });

    console.log(`[Escrow] Released ${amountUsdc} USDC units for user ${userId}, challenge ${challengeId}`);
    return true;
  } catch (err) {
    console.error(`[Escrow] Failed to release funds for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Check if a user can afford a given USDC amount.
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountUsdc - Amount in USDC smallest units.
 * @returns {boolean}
 */
function canAfford(userId, amountUsdc) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) return false;
  const available = BigInt(wallet.balance_available);
  const needed = BigInt(amountUsdc);
  return available >= needed;
}

/**
 * Transfer USDC from a user wallet to the escrow wallet on-chain.
 * Decrypts the user's keypair, sends USDC, reduces held balance,
 * and logs an 'escrow_in' transaction.
 *
 * @param {number} userId - The user's internal ID.
 * @param {string|number} amountUsdc - Amount in USDC smallest units.
 * @param {number} challengeId - The challenge ID.
 * @returns {Promise<{ signature: string }>}
 */
async function transferToEscrow(userId, amountUsdc, challengeId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) {
    throw new Error(`No wallet found for user ${userId}`);
  }

  // Check SOL for gas
  const solBalance = BigInt(await walletManager.getSolBalance(walletRecord.solana_address));
  if (solBalance < BigInt(MIN_SOL_FOR_GAS)) {
    throw new Error(`User ${userId} has insufficient SOL for gas (${solBalance} lamports)`);
  }

  const userKeypair = walletManager.getKeypairFromEncrypted(
    walletRecord.encrypted_private_key,
    walletRecord.encryption_iv,
    walletRecord.encryption_tag,
    walletRecord.encryption_salt,
  );

  const escrowKeypair = getEscrowKeypair();

  // Transfer USDC to escrow
  const { signature } = await transactionService.transferUsdc(
    userKeypair,
    escrowKeypair.publicKey.toBase58(),
    amountUsdc,
  );

  // Transfer a small SOL amount to escrow to cover payout gas fees
  // ~10000 lamports per player covers their share of the resolve transaction
  const GAS_CONTRIBUTION = 10_000; // 0.00001 SOL (~$0.002)
  try {
    await transactionService.transferSol(
      userKeypair,
      escrowKeypair.publicKey.toBase58(),
      GAS_CONTRIBUTION,
    );
  } catch (err) {
    // Non-critical — escrow may already have enough SOL
    console.warn(`[Escrow] Gas contribution from user ${userId} failed (non-critical):`, err.message);
  }

  // Reduce the held balance now that funds are on-chain in escrow
  walletRepo.releaseFunds(userId, amountUsdc);

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN,
    userId,
    challengeId,
    amountUsdc: amountUsdc.toString(),
    solanaTxSignature: signature,
    fromAddress: walletRecord.solana_address,
    toAddress: escrowKeypair.publicKey.toBase58(),
    status: 'completed',
    memo: `Escrow transfer for challenge #${challengeId}`,
  });

  console.log(`[Escrow] Transferred ${amountUsdc} USDC + gas SOL from user ${userId} to escrow. TX: ${signature}`);
  return { signature };
}

/**
 * Disburse winnings from escrow to winners on-chain.
 * Calculates per-player share, deducts platform fee, transfers USDC.
 *
 * @param {number} challengeId - The challenge ID.
 * @param {number[]} winningPlayerIds - Array of winning user IDs.
 * @param {string|number} totalPotUsdc - Total pot amount in USDC smallest units.
 * @returns {Promise<{ disbursements: object[], feeAmount: string }>}
 */
async function disburseWinnings(challengeId, winningPlayerIds, totalPotUsdc) {
  if (!winningPlayerIds || winningPlayerIds.length === 0) {
    throw new Error('No winning player IDs provided');
  }

  const escrowKeypair = getEscrowKeypair();
  const totalPot = BigInt(totalPotUsdc);
  const perPlayerShare = totalPot / BigInt(winningPlayerIds.length);

  const disbursements = [];

  for (const userId of winningPlayerIds) {
    const walletRecord = walletRepo.findByUserId(userId);
    if (!walletRecord) {
      console.error(`[Escrow] No wallet found for winning user ${userId}, skipping`);
      continue;
    }

    try {
      const { signature } = await transactionService.transferUsdc(
        escrowKeypair,
        walletRecord.solana_address,
        perPlayerShare.toString(),
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
        amountUsdc: perPlayerShare.toString(),
        solanaTxSignature: signature,
        fromAddress: escrowKeypair.publicKey.toBase58(),
        toAddress: walletRecord.solana_address,
        status: 'completed',
        memo: `Winnings for challenge #${challengeId}`,
      });

      disbursements.push({ userId, signature, amount: perPlayerShare.toString() });
      console.log(`[Escrow] Disbursed ${perPlayerShare} USDC to user ${userId}. TX: ${signature}`);
    } catch (err) {
      console.error(`[Escrow] Failed to disburse to user ${userId}:`, err.message);
      disbursements.push({ userId, error: err.message });
    }
  }

  return { disbursements };
}

/**
 * Refund all held funds for all players in a challenge.
 * @param {number} challengeId - The challenge ID.
 * @returns {{ refunded: number[], failed: number[] }}
 */
function refundAll(challengeId) {
  const transactions = transactionRepo.findByChallengeId(challengeId);

  const holdsByUser = new Map();
  for (const tx of transactions) {
    if (tx.type === TRANSACTION_TYPE.HOLD && tx.status === 'completed') {
      const current = holdsByUser.get(tx.user_id) || 0n;
      holdsByUser.set(tx.user_id, current + BigInt(tx.amount_usdc));
    }
    if (tx.type === TRANSACTION_TYPE.RELEASE && tx.status === 'completed') {
      const current = holdsByUser.get(tx.user_id) || 0n;
      holdsByUser.set(tx.user_id, current - BigInt(tx.amount_usdc));
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
