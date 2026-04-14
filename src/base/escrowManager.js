// Base escrow manager — smart contract + CDP Smart Accounts.
//
// Every match's USDC flows through the WagerEscrow.sol contract:
//   1. createMatch — registers match on-chain
//   2. depositToEscrow — pulls USDC from each player via transferFrom
//   3. resolveMatch — sends match prize to winners
//   4. cancelMatch — refunds all players
//
// All on-chain calls are signed via CDP Smart Accounts. The bot's
// owner address is stored in CDP_OWNER_ADDRESS env var.
// Each user's CDP wallet signs their approve() call during onboarding.
// The Coinbase Paymaster sponsors gas for everything — no ETH needed.
//
// DB-level hold/release is preserved for the pre-escrow phase
// (challenge accepted → match not yet started).

const { ethers } = require('ethers');
const db = require('../database/db');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('./walletManager');
const transactionService = require('./transactionService');
const { getProvider } = require('./connection');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');

// The escrow contract ABI (JSON format for CDP invokeContract)
const ESCROW_ABI_JSON = [
  { name: 'createMatch', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'entryAmount', type: 'uint256' }, { name: 'playerCount', type: 'uint8' }], outputs: [] },
  { name: 'depositToEscrow', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'player', type: 'address' }], outputs: [] },
  { name: 'resolveMatch', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'winners', type: 'address[]' }, { name: 'amounts', type: 'uint256[]' }], outputs: [] },
  { name: 'cancelMatch', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'players', type: 'address[]' }, { name: 'refunds', type: 'uint256[]' }], outputs: [] },
];

function _ownerAddress() {
  const addr = process.env.CDP_OWNER_ADDRESS;
  if (!addr) throw new Error('CDP_OWNER_ADDRESS not set — needed for escrow contract calls');
  return addr;
}

function _escrowAddress() {
  const addr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!addr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');
  return addr;
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
      userId, challengeId, amountUsdc,
      solanaTxSignature: null, status: 'completed',
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
      userId, challengeId, amountUsdc,
      solanaTxSignature: null, status: 'completed',
      memo: `Release for challenge #${challengeId}`,
    });
    return true;
  } catch (err) {
    console.error(`[Escrow] releaseFunds failed for user ${userId}:`, err.message);
    return false;
  }
}

// ─── On-chain: approve escrow to spend user's USDC ─────────────

async function approveEscrowForUser(userId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) throw new Error(`No wallet for user ${userId}`);

  const { hash } = await transactionService.approveUsdc(
    walletRecord.solana_address,
    _escrowAddress(),
    walletRecord.encrypted_private_key, // owner account name for Smart Account
  );

  console.log(`[Escrow] Approved escrow for user ${userId}: ${hash}`);
  return { hash };
}

// ─── On-chain: create match in the contract ────────────────────

async function createOnChainMatch(matchId, entryAmountUsdc, playerCount) {
  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'createMatch',
    { matchId: String(matchId), entryAmount: String(entryAmountUsdc), playerCount: String(playerCount) },
    ESCROW_ABI_JSON,
  );
  console.log(`[Escrow] On-chain match #${matchId} created: ${hash}`);
  return { hash };
}

// ─── On-chain: deposit player's USDC into escrow ───────────────

async function depositToEscrow(userId, matchId, challengeId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) throw new Error(`No wallet for user ${userId}`);

  // The contract owner calls depositToEscrow which does transferFrom(player, contract, amount)
  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'depositToEscrow',
    { matchId: String(matchId), player: walletRecord.solana_address },
    ESCROW_ABI_JSON,
  );

  // Zero out held balance in DB (funds now in contract)
  const provider = getProvider();
  const escrowAbi = ['function getMatch(uint256) view returns (tuple(uint256,uint8,uint8,uint256,bool,bool))'];
  const escrowContract = new ethers.Contract(_escrowAddress(), escrowAbi, provider);
  const matchData = await escrowContract.getMatch(matchId);
  const entryAmount = matchData[0].toString();

  const freshWallet = walletRepo.findByUserId(userId);
  const newHeld = (BigInt(freshWallet.balance_held) - BigInt(entryAmount)).toString();
  walletRepo.updateBalance(userId, {
    balanceAvailable: freshWallet.balance_available,
    balanceHeld: newHeld,
  });

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN || 'escrow_in',
    userId, challengeId, amountUsdc: entryAmount,
    solanaTxSignature: hash,
    fromAddress: walletRecord.solana_address,
    toAddress: _escrowAddress(),
    status: 'completed',
    memo: `Escrow deposit for match #${matchId}`,
  });

  console.log(`[Escrow] User ${userId} deposited to match #${matchId}: ${hash}`);
  return { hash };
}

// ─── On-chain: transfer all players' USDC to escrow ────────────

async function transferToEscrow(matchId, challengeId, allPlayers, entryAmountUsdc, playerCount) {
  await createOnChainMatch(matchId, entryAmountUsdc, playerCount);
  for (const player of allPlayers) {
    await depositToEscrow(player.user_id, matchId, challengeId);
  }
}

// ─── On-chain: resolve match → pay winners ─────────────────────

async function disburseWinnings(matchId, challengeId, winningPlayerIds, totalPotUsdc) {
  if (!winningPlayerIds || winningPlayerIds.length === 0) {
    throw new Error('No winning player IDs provided');
  }

  const matchPrize = BigInt(totalPotUsdc);
  const perPlayerShare = matchPrize / BigInt(winningPlayerIds.length);

  const winnerAddresses = [];
  const winnerAmounts = [];
  const disbursements = [];

  for (const userId of winningPlayerIds) {
    const walletRecord = walletRepo.findByUserId(userId);
    if (!walletRecord) {
      disbursements.push({ userId, error: 'no wallet' });
      continue;
    }
    winnerAddresses.push(walletRecord.solana_address);
    winnerAmounts.push(perPlayerShare.toString());
    disbursements.push({ userId, address: walletRecord.solana_address, amount: perPlayerShare.toString() });
  }

  if (winnerAddresses.length === 0) throw new Error('No winners with wallets');

  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'resolveMatch',
    {
      matchId: String(matchId),
      winners: winnerAddresses,
      amounts: winnerAmounts,
    },
    ESCROW_ABI_JSON,
  );

  // Credit each winner's DB balance
  for (const d of disbursements) {
    if (d.error) continue;
    try {
      walletRepo.creditAvailable(d.userId, d.amount);
      transactionRepo.create({
        type: TRANSACTION_TYPE.DISBURSEMENT || 'disbursement',
        userId: d.userId, challengeId,
        amountUsdc: d.amount,
        solanaTxSignature: hash,
        fromAddress: _escrowAddress(),
        toAddress: d.address,
        status: 'completed',
        memo: `Winnings for match #${matchId}`,
      });
      d.hash = hash;
    } catch (err) {
      d.error = err.message;
    }
  }

  console.log(`[Escrow] Match #${matchId} resolved: ${winnerAddresses.length} winners. TX: ${hash}`);
  return { disbursements, hash };
}

// ─── On-chain: cancel match → refund all ───────────────────────

async function cancelOnChainMatch(matchId, challengeId, allPlayers, entryAmountUsdc) {
  const playerAddresses = [];
  const refundAmounts = [];

  for (const player of allPlayers) {
    const wallet = walletRepo.findByUserId(player.user_id);
    if (!wallet) continue;
    playerAddresses.push(wallet.solana_address);
    refundAmounts.push(entryAmountUsdc);
  }

  if (playerAddresses.length === 0) return;

  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'cancelMatch',
    {
      matchId: String(matchId),
      players: playerAddresses,
      refunds: refundAmounts,
    },
    ESCROW_ABI_JSON,
  );

  for (const player of allPlayers) {
    try {
      walletRepo.creditAvailable(player.user_id, entryAmountUsdc);
      transactionRepo.create({
        type: 'refund',
        userId: player.user_id, challengeId,
        amountUsdc: entryAmountUsdc,
        solanaTxSignature: hash,
        fromAddress: _escrowAddress(),
        toAddress: walletRepo.findByUserId(player.user_id)?.solana_address || '',
        status: 'completed',
        memo: `Refund for cancelled match #${matchId}`,
      });
    } catch (err) {
      console.error(`[Escrow] Credit refund failed for user ${player.user_id}:`, err.message);
    }
  }

  console.log(`[Escrow] Match #${matchId} cancelled. ${playerAddresses.length} refunded. TX: ${hash}`);
  return { hash };
}

// ─── DB-level refund (pre-escrow, never hit chain) ─────────────

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
        type: 'refund', userId: parseInt(userId), challengeId,
        amountUsdc: net.toString(), solanaTxSignature: null,
        status: 'completed',
        memo: `Refund for cancelled challenge #${challengeId}`,
      });
      refunded.push(parseInt(userId));
    } catch (err) {
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
