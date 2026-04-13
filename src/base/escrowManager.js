// Base escrow manager.
//
// Same hold/release/disburse/refund state machine as the Solana
// version, but on-chain transfers use ERC-20 USDC on Base via
// the hot wallet (a single bot-controlled wallet that holds all
// escrowed USDC, rather than per-user escrow transfers like the
// old Solana model).
//
// Architecture:
//   hold/release   = DB-only balance locks (available ↔ held)
//   transferToEscrow = ERC-20 transfer from user wallet → hot wallet
//   disburseWinnings = ERC-20 transfer from hot wallet → winner wallets
//   refundAll        = DB release of held → available (+ on-chain refund
//                      if funds were already escrowed)

const db = require('../database/db');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const transactionService = require('./transactionService');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');

/**
 * Check if a user can afford to hold a given USDC amount.
 */
function canAfford(userId, amountUsdc) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) return false;
  return BigInt(wallet.balance_available) >= BigInt(amountUsdc);
}

/**
 * Hold funds — DB-level lock, no on-chain transfer.
 * Moves from available → held. Returns true on success.
 */
function holdFunds(userId, amountUsdc, challengeId) {
  try {
    walletRepo.holdFunds(userId, amountUsdc);

    transactionRepo.create({
      type: TRANSACTION_TYPE.HOLD || 'hold',
      userId,
      challengeId,
      amountUsdc,
      solanaTxSignature: null, // DB-only, no on-chain sig
      status: 'completed',
      memo: `Hold for challenge #${challengeId}`,
    });

    return true;
  } catch (err) {
    console.error(`[Escrow] holdFunds failed for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Release held funds back to available — DB-level unlock.
 */
function releaseFunds(userId, amountUsdc, challengeId) {
  try {
    walletRepo.releaseFunds(userId, amountUsdc);
    transactionRepo.create({
      type: TRANSACTION_TYPE.RELEASE || 'release',
      userId,
      challengeId,
      amountUsdc,
      solanaTxSignature: null,
      status: 'completed',
      memo: `Release for challenge #${challengeId}`,
    });
    return true;
  } catch (err) {
    console.error(`[Escrow] releaseFunds failed for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Transfer USDC from a user's bot wallet to the hot wallet (escrow).
 * Called when a match starts — moves real USDC on-chain.
 */
async function transferToEscrow(userId, amountUsdc, challengeId) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) throw new Error(`No wallet for user ${userId}`);

  const userSigner = walletManager.getWalletFromEncrypted(
    wallet.encrypted_private_key,
    wallet.encryption_iv,
    wallet.encryption_tag,
    wallet.encryption_salt,
  );

  const hotWallet = transactionService.getHotWalletSigner();
  const { hash } = await transactionService.transferUsdc(
    userSigner,
    hotWallet.address,
    amountUsdc,
  );

  // Zero out the held balance in DB since the funds are now in the hot wallet
  const freshWallet = walletRepo.findByUserId(userId);
  const newHeld = (BigInt(freshWallet.balance_held) - BigInt(amountUsdc)).toString();
  walletRepo.updateBalance(userId, {
    balanceAvailable: freshWallet.balance_available,
    balanceHeld: newHeld,
  });

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN || 'escrow_in',
    userId,
    challengeId,
    amountUsdc,
    solanaTxSignature: hash, // reusing the column name for Base tx hash
    fromAddress: wallet.solana_address, // column name is legacy but stores the Base address
    toAddress: hotWallet.address,
    status: 'completed',
    memo: `Escrow deposit for challenge #${challengeId}`,
  });

  console.log(`[Escrow] Transferred ${amountUsdc} USDC from user ${userId} to escrow. TX: ${hash}`);
  return { hash };
}

/**
 * Disburse winnings from the hot wallet to winners.
 */
async function disburseWinnings(challengeId, winningPlayerIds, totalPotUsdc) {
  if (!winningPlayerIds || winningPlayerIds.length === 0) {
    throw new Error('No winning player IDs provided');
  }

  const hotWallet = transactionService.getHotWalletSigner();
  const totalPot = BigInt(totalPotUsdc);
  const perPlayerShare = totalPot / BigInt(winningPlayerIds.length);
  const disbursements = [];

  for (const userId of winningPlayerIds) {
    const walletRecord = walletRepo.findByUserId(userId);
    if (!walletRecord) {
      console.error(`[Escrow] No wallet for winning user ${userId}, skipping`);
      disbursements.push({ userId, error: 'no wallet' });
      continue;
    }

    try {
      const { hash } = await transactionService.transferUsdc(
        hotWallet,
        walletRecord.solana_address, // column name is legacy but stores the Base address
        perPlayerShare.toString(),
      );

      // Credit winner using fresh-read transaction
      walletRepo.creditAvailable(userId, perPlayerShare.toString());

      transactionRepo.create({
        type: TRANSACTION_TYPE.DISBURSEMENT || 'disbursement',
        userId,
        challengeId,
        amountUsdc: perPlayerShare.toString(),
        solanaTxSignature: hash,
        fromAddress: hotWallet.address,
        toAddress: walletRecord.solana_address,
        status: 'completed',
        memo: `Winnings for challenge #${challengeId}`,
      });

      disbursements.push({ userId, hash, amount: perPlayerShare.toString() });
      console.log(`[Escrow] Disbursed ${perPlayerShare} USDC to user ${userId}. TX: ${hash}`);
    } catch (err) {
      console.error(`[Escrow] Failed to disburse to user ${userId}:`, err.message);
      disbursements.push({ userId, error: err.message });
    }
  }

  return { disbursements };
}

/**
 * Refund all held funds for all players in a challenge.
 * DB-level release — returns held → available.
 */
function refundAll(challengeId) {
  const transactions = transactionRepo.findByChallengeId(challengeId);
  const holdAmounts = {};

  for (const tx of transactions) {
    if (tx.type === 'hold') {
      holdAmounts[tx.user_id] = (holdAmounts[tx.user_id] || 0n) + BigInt(tx.amount_usdc);
    } else if (tx.type === 'release' || tx.type === 'refund') {
      holdAmounts[tx.user_id] = (holdAmounts[tx.user_id] || 0n) - BigInt(tx.amount_usdc);
    }
  }

  const refunded = [];
  const failed = [];

  for (const [userId, net] of Object.entries(holdAmounts)) {
    if (net <= 0n) continue;
    try {
      walletRepo.releaseFunds(parseInt(userId), net.toString());
      transactionRepo.create({
        type: 'refund',
        userId: parseInt(userId),
        challengeId,
        amountUsdc: net.toString(),
        solanaTxSignature: null,
        status: 'completed',
        memo: `Refund for cancelled challenge #${challengeId}`,
      });
      refunded.push(parseInt(userId));
    } catch (err) {
      console.error(`[Escrow] Failed to refund user ${userId}:`, err.message);
      failed.push(parseInt(userId));
    }
  }

  return { refunded, failed };
}

module.exports = {
  canAfford,
  holdFunds,
  releaseFunds,
  transferToEscrow,
  disburseWinnings,
  refundAll,
};
