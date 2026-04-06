const { Keypair, PublicKey } = require('@solana/web3.js');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const transactionService = require('./transactionService');
const { TRANSACTION_TYPE, MIN_SOL_FOR_GAS, USDC_PER_UNIT } = require('../config/constants');
const { postTransaction } = require('../utils/transactionFeed');

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

    const userRecord = require('../database/repositories/userRepo').findById(userId);
    postTransaction({ type: 'hold', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${(Number(amountUsdc) / USDC_PER_UNIT).toFixed(2)}`, currency: 'USDC', fromAddress: wallet?.solana_address, challengeId, memo: `Hold for challenge #${challengeId}` });
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

    const userRecord = require('../database/repositories/userRepo').findById(userId);
    postTransaction({ type: 'release', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${(Number(amountUsdc) / USDC_PER_UNIT).toFixed(2)}`, currency: 'USDC', toAddress: wallet?.solana_address, challengeId, memo: `Release for challenge #${challengeId}` });
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

  // Check SOL for gas and record pre-transfer balance
  const solBefore = BigInt(await walletManager.getSolBalance(walletRecord.solana_address));
  if (solBefore < BigInt(MIN_SOL_FOR_GAS)) {
    throw new Error(`User ${userId} has insufficient SOL for gas (${solBefore} lamports)`);
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
  const GAS_CONTRIBUTION = 10_000; // 0.00001 SOL
  try {
    const { signature: solSig } = await transactionService.transferSol(
      userKeypair,
      escrowKeypair.publicKey.toBase58(),
      GAS_CONTRIBUTION,
    );

    transactionRepo.create({
      type: 'gas_contribution',
      userId,
      challengeId,
      amountUsdc: '0',
      solanaTxSignature: solSig,
      fromAddress: walletRecord.solana_address,
      toAddress: escrowKeypair.publicKey.toBase58(),
      status: 'completed',
      memo: `Gas contribution (${GAS_CONTRIBUTION} lamports) for challenge #${challengeId}`,
    });
  } catch (err) {
    console.warn(`[Escrow] Gas contribution from user ${userId} failed (non-critical):`, err.message);
  }

  // Remove the held balance — funds are now on-chain in escrow (NOT back to available)
  const walletAfter = walletRepo.findByUserId(userId);
  const heldAfter = BigInt(walletAfter.balance_held) - BigInt(amountUsdc);
  walletRepo.updateBalance(userId, {
    balanceAvailable: walletAfter.balance_available,
    balanceHeld: (heldAfter < 0n ? 0n : heldAfter).toString(),
  });

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

  // Calculate actual gas spent by checking SOL balance before vs after
  const solAfter = BigInt(await walletManager.getSolBalance(walletRecord.solana_address));
  const gasSpent = solBefore - solAfter;

  const userRecord = require('../database/repositories/userRepo').findById(userId);
  postTransaction({ type: 'escrow_in', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: `$${(Number(amountUsdc) / USDC_PER_UNIT).toFixed(2)}`, currency: 'USDC', fromAddress: walletRecord.solana_address, toAddress: escrowKeypair.publicKey.toBase58(), signature, challengeId, memo: `Escrow transfer for challenge #${challengeId} | Gas: ${gasSpent.toString()} lamports (${(Number(gasSpent) / 1_000_000_000).toFixed(8)} SOL)` });
  // Verify on-chain USDC balance matches DB after transfer
  const onChainUsdc = BigInt(await walletManager.getUsdcBalance(walletRecord.solana_address));
  const dbWalletAfter = walletRepo.findByUserId(userId);
  const dbTotal = BigInt(dbWalletAfter.balance_available) + BigInt(dbWalletAfter.balance_held);
  if (onChainUsdc !== dbTotal) {
    console.warn(`[Escrow] BALANCE MISMATCH after escrow transfer for user ${userId}: on-chain=${onChainUsdc}, DB=${dbTotal}`);
    postTransaction({ type: 'escrow_in', username: userRecord?.server_username, discordId: userRecord?.discord_id, amount: 'MISMATCH', currency: '', memo: `⚠️ On-chain: ${onChainUsdc} vs DB: ${dbTotal}` });
  }

  console.log(`[Escrow] Transferred ${amountUsdc} USDC from user ${userId} to escrow. Gas: ${gasSpent} lamports. TX: ${signature}`);
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

      const winUserRecord = require('../database/repositories/userRepo').findById(userId);
      postTransaction({ type: 'disbursement', username: winUserRecord?.server_username, discordId: winUserRecord?.discord_id, amount: `$${(Number(perPlayerShare) / USDC_PER_UNIT).toFixed(2)}`, currency: 'USDC', fromAddress: escrowKeypair.publicKey.toBase58(), toAddress: walletRecord.solana_address, signature, challengeId, memo: `Winnings for challenge #${challengeId}` });
      // Verify on-chain balance matches DB after disbursement
      const verifyBalance = BigInt(await walletManager.getUsdcBalance(walletRecord.solana_address));
      const verifyDb = walletRepo.findByUserId(userId);
      const verifyDbTotal = BigInt(verifyDb.balance_available) + BigInt(verifyDb.balance_held);
      if (verifyBalance !== verifyDbTotal) {
        console.warn(`[Escrow] BALANCE MISMATCH after disbursement for user ${userId}: on-chain=${verifyBalance}, DB=${verifyDbTotal}`);
        postTransaction({ type: 'disbursement', username: winUserRecord?.server_username, discordId: winUserRecord?.discord_id, amount: 'MISMATCH', currency: '', memo: `⚠️ On-chain: ${verifyBalance} vs DB: ${verifyDbTotal}` });
      }

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
