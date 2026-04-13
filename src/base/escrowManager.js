// Base escrow manager — smart contract integration.
//
// Every match's USDC flows through the WagerEscrow.sol contract:
//   1. createMatch — registers match on-chain
//   2. depositToEscrow — pulls USDC from each player via transferFrom
//   3. resolveMatch — sends pot to winners
//   4. cancelMatch — refunds all players
//
// The bot (contract owner) signs all contract calls using the gas
// funder wallet. Each player's USDC is pulled from their INDIVIDUAL
// wallet via ERC-20 transferFrom — requires prior approve() by the
// player's wallet on the USDC contract.
//
// DB-level hold/release is preserved for the pre-escrow phase
// (challenge accepted → match not yet started). On-chain transfer
// only happens at match start (depositToEscrow).

const { ethers } = require('ethers');
const db = require('../database/db');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const { getProvider } = require('./connection');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');

// Minimal ABI for the WagerEscrow contract — only the functions we call.
const ESCROW_ABI = [
  'function createMatch(uint256 matchId, uint256 entryAmount, uint8 playerCount) external',
  'function depositToEscrow(uint256 matchId, address player) external',
  'function resolveMatch(uint256 matchId, address[] winners, uint256[] amounts) external',
  'function cancelMatch(uint256 matchId, address[] players, uint256[] refunds) external',
  'function getMatch(uint256 matchId) external view returns (tuple(uint256 entryAmount, uint8 playerCount, uint8 depositsCount, uint256 totalDeposited, bool resolved, bool cancelled))',
  'function getContractUsdcBalance() external view returns (uint256)',
];

// ERC-20 approve ABI (for the one-time approval flow)
const APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

function _getEscrowContract(signer) {
  const addr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!addr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');
  return new ethers.Contract(addr, ESCROW_ABI, signer || getProvider());
}

function _getGasFunderSigner() {
  const key = process.env.GAS_FUNDER_PRIVATE_KEY;
  if (!key) throw new Error('GAS_FUNDER_PRIVATE_KEY not set');
  return new ethers.Wallet(key, getProvider());
}

// ─── DB-level hold/release (pre-escrow phase) ──────────────────

function canAfford(userId, amountUsdc) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) return false;
  return BigInt(wallet.balance_available) >= BigInt(amountUsdc);
}

function holdFunds(userId, amountUsdc, challengeId) {
  try {
    walletRepo.holdFunds(userId, amountUsdc);
    transactionRepo.create({
      type: TRANSACTION_TYPE.HOLD || 'hold',
      userId,
      challengeId,
      amountUsdc,
      solanaTxSignature: null,
      status: 'completed',
      memo: `Hold for challenge #${challengeId}`,
    });
    return true;
  } catch (err) {
    console.error(`[Escrow] holdFunds failed for user ${userId}:`, err.message);
    return false;
  }
}

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

// ─── On-chain escrow operations ────────────────────────────────

/**
 * Approve the escrow contract to spend USDC from a user's wallet.
 * Called once during onboarding or before the user's first match.
 * Sets allowance to max uint256 so it never needs to be renewed.
 */
async function approveEscrowForUser(userId) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) throw new Error(`No wallet for user ${userId}`);

  const userSigner = walletManager.getWalletFromEncrypted(
    wallet.encrypted_private_key,
    wallet.encryption_iv,
    wallet.encryption_tag,
    wallet.encryption_salt,
  );

  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!escrowAddr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');

  const usdcContract = new ethers.Contract(
    walletManager.USDC_CONTRACT,
    APPROVE_ABI,
    userSigner,
  );

  // Check current allowance first — skip if already approved
  const currentAllowance = await usdcContract.allowance(userSigner.address, escrowAddr);
  if (currentAllowance > BigInt(1e18)) {
    console.log(`[Escrow] User ${userId} already has sufficient allowance`);
    return { hash: null, alreadyApproved: true };
  }

  const tx = await usdcContract.approve(escrowAddr, ethers.MaxUint256);
  const receipt = await tx.wait();
  console.log(`[Escrow] Approved escrow for user ${userId}: ${tx.hash}`);
  return { hash: tx.hash, receipt };
}

/**
 * Create a match on-chain. Called when all participants are confirmed.
 * The gas funder signs (it's the contract owner).
 */
async function createOnChainMatch(matchId, entryAmountUsdc, playerCount) {
  const gasFunder = _getGasFunderSigner();
  const contract = _getEscrowContract(gasFunder);

  const tx = await contract.createMatch(matchId, entryAmountUsdc, playerCount);
  const receipt = await tx.wait();
  console.log(`[Escrow] On-chain match #${matchId} created: ${tx.hash}`);
  return { hash: tx.hash, receipt };
}

/**
 * Pull USDC from a player's wallet into the escrow contract.
 * The gas funder signs the contract call; the contract does
 * transferFrom(player, contract, amount) — requires prior approve().
 */
async function depositToEscrow(userId, matchId, challengeId) {
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) throw new Error(`No wallet for user ${userId}`);

  const gasFunder = _getGasFunderSigner();
  const contract = _getEscrowContract(gasFunder);

  const tx = await contract.depositToEscrow(matchId, wallet.solana_address);
  const receipt = await tx.wait();

  // Zero out the held balance in DB (funds are now in the contract)
  const freshWallet = walletRepo.findByUserId(userId);
  const matchData = await contract.getMatch(matchId);
  const entryAmount = matchData.entryAmount.toString();

  const newHeld = (BigInt(freshWallet.balance_held) - BigInt(entryAmount)).toString();
  walletRepo.updateBalance(userId, {
    balanceAvailable: freshWallet.balance_available,
    balanceHeld: newHeld,
  });

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN || 'escrow_in',
    userId,
    challengeId,
    amountUsdc: entryAmount,
    solanaTxSignature: tx.hash,
    fromAddress: wallet.solana_address,
    toAddress: process.env.ESCROW_CONTRACT_ADDRESS,
    status: 'completed',
    memo: `Escrow deposit for match #${matchId}`,
  });

  console.log(`[Escrow] User ${userId} deposited to match #${matchId}: ${tx.hash}`);
  return { hash: tx.hash };
}

/**
 * Transfer USDC from each player's wallet to escrow for a match.
 * Called when a match starts — loops all players.
 */
async function transferToEscrow(matchId, challengeId, allPlayers, entryAmountUsdc, playerCount) {
  // Step 1: create the match on-chain
  await createOnChainMatch(matchId, entryAmountUsdc, playerCount);

  // Step 2: deposit each player's entry
  for (const player of allPlayers) {
    await depositToEscrow(player.user_id, matchId, challengeId);
  }
}

/**
 * Resolve a match — distribute pot to winners via the smart contract.
 */
async function disburseWinnings(matchId, challengeId, winningPlayerIds, totalPotUsdc) {
  if (!winningPlayerIds || winningPlayerIds.length === 0) {
    throw new Error('No winning player IDs provided');
  }

  const gasFunder = _getGasFunderSigner();
  const contract = _getEscrowContract(gasFunder);
  const totalPot = BigInt(totalPotUsdc);
  const perPlayerShare = totalPot / BigInt(winningPlayerIds.length);

  // Build arrays for the contract call
  const winnerAddresses = [];
  const winnerAmounts = [];
  const disbursements = [];

  for (const userId of winningPlayerIds) {
    const walletRecord = walletRepo.findByUserId(userId);
    if (!walletRecord) {
      console.error(`[Escrow] No wallet for winning user ${userId}, skipping`);
      disbursements.push({ userId, error: 'no wallet' });
      continue;
    }
    winnerAddresses.push(walletRecord.solana_address);
    winnerAmounts.push(perPlayerShare);
    disbursements.push({ userId, address: walletRecord.solana_address, amount: perPlayerShare.toString() });
  }

  if (winnerAddresses.length === 0) {
    throw new Error('No winners with wallets found');
  }

  // Call the contract — sends USDC from contract to each winner
  const tx = await contract.resolveMatch(matchId, winnerAddresses, winnerAmounts);
  const receipt = await tx.wait();

  // Credit each winner's DB balance
  for (const d of disbursements) {
    if (d.error) continue;
    try {
      walletRepo.creditAvailable(d.userId, d.amount);
      transactionRepo.create({
        type: TRANSACTION_TYPE.DISBURSEMENT || 'disbursement',
        userId: d.userId,
        challengeId,
        amountUsdc: d.amount,
        solanaTxSignature: tx.hash,
        fromAddress: process.env.ESCROW_CONTRACT_ADDRESS,
        toAddress: d.address,
        status: 'completed',
        memo: `Winnings for match #${matchId}`,
      });
      d.hash = tx.hash;
    } catch (err) {
      console.error(`[Escrow] Failed to credit winner ${d.userId}:`, err.message);
      d.error = err.message;
    }
  }

  console.log(`[Escrow] Match #${matchId} resolved: ${winnerAddresses.length} winners paid. TX: ${tx.hash}`);
  return { disbursements, hash: tx.hash };
}

/**
 * Cancel a match — refund all players via the smart contract.
 */
async function cancelOnChainMatch(matchId, challengeId, allPlayers, entryAmountUsdc) {
  const gasFunder = _getGasFunderSigner();
  const contract = _getEscrowContract(gasFunder);

  const playerAddresses = [];
  const refundAmounts = [];

  for (const player of allPlayers) {
    const wallet = walletRepo.findByUserId(player.user_id);
    if (!wallet) continue;
    playerAddresses.push(wallet.solana_address);
    refundAmounts.push(BigInt(entryAmountUsdc));
  }

  if (playerAddresses.length === 0) return;

  const tx = await contract.cancelMatch(matchId, playerAddresses, refundAmounts);
  const receipt = await tx.wait();

  // Credit each player's DB balance
  for (const player of allPlayers) {
    try {
      walletRepo.creditAvailable(player.user_id, entryAmountUsdc);
      transactionRepo.create({
        type: 'refund',
        userId: player.user_id,
        challengeId,
        amountUsdc: entryAmountUsdc,
        solanaTxSignature: tx.hash,
        fromAddress: process.env.ESCROW_CONTRACT_ADDRESS,
        toAddress: walletRepo.findByUserId(player.user_id)?.solana_address || '',
        status: 'completed',
        memo: `Refund for cancelled match #${matchId}`,
      });
    } catch (err) {
      console.error(`[Escrow] Failed to credit refund for user ${player.user_id}:`, err.message);
    }
  }

  console.log(`[Escrow] Match #${matchId} cancelled. ${playerAddresses.length} players refunded. TX: ${tx.hash}`);
  return { hash: tx.hash };
}

/**
 * Refund all held funds for all players in a challenge.
 * DB-level release — returns held → available. Used for challenges
 * that never reached the on-chain escrow phase (cancelled before
 * match start).
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
  approveEscrowForUser,
  createOnChainMatch,
  depositToEscrow,
  transferToEscrow,
  disburseWinnings,
  cancelOnChainMatch,
  refundAll,
};
