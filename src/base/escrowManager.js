// Base escrow manager — smart contract interactions.
//
// Every match's USDC flows through the WagerEscrow.sol contract:
//   1. createMatch — registers match on-chain
//   2. depositToEscrow — pulls USDC from each player via transferFrom
//   3. resolveMatch — sends match prize to winners
//   4. cancelMatch — refunds all players
//
// Owner-level calls (createMatch, depositToEscrow, resolveMatch, cancelMatch)
// are signed by the bot's owner EOA (CDP_OWNER_ADDRESS env var).
//
// User-level calls (approve) use the user's CDP Smart Account when
// available (gasless via Paymaster), with EOA fallback.
//
// DB-level hold/release is preserved for the pre-escrow phase
// (challenge accepted -> match not yet started).

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
      type: TRANSACTION_TYPE.HOLD,
      userId, challengeId, amountUsdc,
      txHash: null, status: 'completed',
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
      type: TRANSACTION_TYPE.RELEASE,
      userId, challengeId, amountUsdc,
      txHash: null, status: 'completed',
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
    walletRecord.address,
    _escrowAddress(),
    { ownerRef: walletRecord.account_ref, smartRef: walletRecord.smart_account_ref },
  );

  console.log(`[Escrow] Approved escrow for user ${userId}: ${hash}`);
  return { hash };
}

// ─── On-chain: create match in the contract ────────────────────

async function createOnChainMatch(matchId, entryAmountUsdc, playerCount) {
  console.log(`[Escrow] createOnChainMatch: matchId=${matchId} entry=${entryAmountUsdc} players=${playerCount}`);
  console.log(`[Escrow]   owner=${_ownerAddress()} escrow=${_escrowAddress()}`);

  // Static call first to get revert reason if it would fail
  try {
    const provider = getProvider();
    const testAbi = ['function createMatch(uint256 matchId, uint256 entryAmount, uint8 playerCount)'];
    const testContract = new ethers.Contract(_escrowAddress(), testAbi, provider);
    await testContract.createMatch.staticCall(matchId, entryAmountUsdc, playerCount, { from: _ownerAddress() });
    console.log(`[Escrow]   static call OK — proceeding with real tx`);
  } catch (staticErr) {
    console.error(`[Escrow]   static call REVERTED: ${staticErr.reason || staticErr.message}`);
    throw new Error(`createMatch would revert: ${staticErr.reason || staticErr.message}`);
  }

  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'createMatch',
    { matchId: String(matchId), entryAmount: String(entryAmountUsdc), playerCount: String(playerCount) },
    ESCROW_ABI_JSON,
  );
  console.log(`[Escrow] On-chain match #${matchId} created: ${hash}`);

  // Wait for the transaction to be confirmed before proceeding
  // to deposits — the match must exist on-chain first.
  const provider = getProvider();
  console.log(`[Escrow]   waiting for createMatch tx confirmation...`);
  await provider.waitForTransaction(hash, 1, 30000);
  console.log(`[Escrow]   createMatch confirmed on-chain`);

  return { hash };
}

// ─── On-chain: deposit player's USDC into escrow ───────────────

async function depositToEscrow(userId, matchId, challengeId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) throw new Error(`No wallet for user ${userId}`);

  console.log(`[Escrow] depositToEscrow: user=${userId} match=${matchId} address=${walletRecord.address}`);

  // Check on-chain USDC balance
  const checkProvider = getProvider();
  const balAbi = ['function balanceOf(address) view returns (uint256)'];
  const usdcForBal = new ethers.Contract(walletManager.USDC_CONTRACT, balAbi, checkProvider);
  const onChainBal = await usdcForBal.balanceOf(walletRecord.address);
  console.log(`[Escrow]   on-chain USDC: ${onChainBal.toString()} (${(Number(onChainBal) / 1e6).toFixed(2)} USDC)`);

  // Verify the user's Smart Account has approved the escrow contract
  const allowanceAbi = ['function allowance(address owner, address spender) view returns (uint256)'];
  const usdcContract = new ethers.Contract(walletManager.USDC_CONTRACT, allowanceAbi, checkProvider);
  const allowance = await usdcContract.allowance(walletRecord.address, _escrowAddress());
  console.log(`[Escrow]   allowance: ${allowance.toString()}`);

  if (allowance === 0n) {
    console.warn(`[Escrow]   user ${userId} has no escrow allowance — retrying approval`);
    await approveEscrowForUser(userId);
    const newAllowance = await usdcContract.allowance(walletRecord.address, _escrowAddress());
    console.log(`[Escrow]   allowance after retry: ${newAllowance.toString()}`);
  }

  // Static call to check if depositToEscrow would revert
  try {
    const testAbi = ['function depositToEscrow(uint256 matchId, address player)'];
    const testContract = new ethers.Contract(_escrowAddress(), testAbi, checkProvider);
    await testContract.depositToEscrow.staticCall(matchId, walletRecord.address, { from: _ownerAddress() });
    console.log(`[Escrow]   static call OK — proceeding with real tx`);
  } catch (staticErr) {
    console.error(`[Escrow]   static call REVERTED: ${staticErr.reason || staticErr.message}`);
    throw new Error(`depositToEscrow would revert for user ${userId}: ${staticErr.reason || staticErr.message}`);
  }

  // The contract owner calls depositToEscrow which does transferFrom(player, contract, amount)
  const { hash } = await transactionService.invokeContract(
    _ownerAddress(),
    _escrowAddress(),
    'depositToEscrow',
    { matchId: String(matchId), player: walletRecord.address },
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
    type: TRANSACTION_TYPE.ESCROW_IN,
    userId, challengeId, amountUsdc: entryAmount,
    txHash: hash,
    fromAddress: walletRecord.address,
    toAddress: _escrowAddress(),
    status: 'completed',
    memo: `Escrow deposit for match #${matchId}`,
  });

  console.log(`[Escrow] User ${userId} deposited to match #${matchId}: ${hash}`);
  return { hash };
}

// ─── On-chain: transfer all players' USDC to escrow ────────────

async function transferToEscrow(matchId, challengeId, allPlayers, entryAmountUsdc, playerCount) {
  console.log(`[Escrow] transferToEscrow: match=${matchId} challenge=${challengeId} entry=${entryAmountUsdc} players=${playerCount}`);
  console.log(`[Escrow]   player IDs: ${allPlayers.map(p => p.user_id).join(', ')}`);

  await createOnChainMatch(matchId, entryAmountUsdc, playerCount);

  for (const player of allPlayers) {
    console.log(`[Escrow]   depositing for player ${player.user_id}...`);
    await depositToEscrow(player.user_id, matchId, challengeId);
  }
  console.log(`[Escrow] transferToEscrow complete for match #${matchId}`);
}

// ─── On-chain: resolve match → pay winners ─────────────────────

async function disburseWinnings(matchId, challengeId, winningPlayerIds, totalPotUsdc, { fromDispute = false } = {}) {
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
    winnerAddresses.push(walletRecord.address);
    winnerAmounts.push(perPlayerShare.toString());
    disbursements.push({ userId, address: walletRecord.address, amount: perPlayerShare.toString() });
  }

  if (winnerAddresses.length === 0) throw new Error('No winners with wallets');

  const txType = fromDispute ? TRANSACTION_TYPE.DISPUTE_HOLD_CREDIT : TRANSACTION_TYPE.DISBURSEMENT;
  const baseMemo = fromDispute
    ? `Winnings for match #${matchId} (held 36h — dispute resolution)`
    : `Winnings for match #${matchId}`;

  // Pre-log intent BEFORE the on-chain tx. If the bot crashes between
  // the tx landing and the DB credit, the poller can pick the delta
  // up and reconcile it against these rows instead of mis-tagging it
  // as a fresh deposit. Status starts as 'pending_onchain'; flipped
  // to 'completed' (or 'pending_release' for dispute holds) after
  // the DB credit succeeds below.
  for (const d of disbursements) {
    if (d.error) continue;
    try {
      const row = transactionRepo.create({
        type: txType,
        userId: d.userId, challengeId,
        amountUsdc: d.amount,
        txHash: null,
        fromAddress: _escrowAddress(),
        toAddress: d.address,
        status: 'pending_onchain',
        memo: `${baseMemo} — tx pending`,
      });
      d.pendingTxId = row.id;
    } catch (err) {
      console.error(`[Escrow] Failed to pre-log disbursement for user ${d.userId}:`, err.message);
      d.error = err.message;
    }
  }

  // Send the on-chain tx.
  let onChainHash;
  try {
    const result = await transactionService.invokeContract(
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
    onChainHash = result.hash;
  } catch (err) {
    // On-chain call failed entirely — mark the pre-logged rows as
    // failed so they don't get matched by the poller later.
    for (const d of disbursements) {
      if (d.pendingTxId) {
        try {
          transactionRepo.updateStatusAndHash(d.pendingTxId, 'failed', null, `${baseMemo} — on-chain call failed: ${err.message}`);
        } catch { /* ignore */ }
      }
    }
    throw err;
  }

  // Credit each winner's DB balance + flip the pre-logged row to
  // completed (or pending_release for dispute holds). If the DB
  // credit throws for some reason, we leave the row as 'pending_onchain'
  // so the poller can fix it up when the delta is observed.
  const { TIMERS } = require('../config/constants');
  const releaseAt = fromDispute
    ? new Date(Date.now() + TIMERS.DISPUTE_HOLD).toISOString()
    : null;

  for (const d of disbursements) {
    if (d.error || !d.pendingTxId) continue;
    try {
      if (fromDispute) {
        walletRepo.creditPending(d.userId, d.amount, releaseAt);
      } else {
        walletRepo.creditAvailable(d.userId, d.amount);
      }
      transactionRepo.updateStatusAndHash(
        d.pendingTxId,
        fromDispute ? 'pending_release' : 'completed',
        onChainHash,
        baseMemo,
      );
      d.hash = onChainHash;
    } catch (err) {
      d.error = err.message;
      console.error(`[Escrow] CRITICAL: DB credit failed AFTER on-chain disbursement for user ${d.userId} match #${matchId}: ${err.message}. On-chain funds WERE sent (tx=${onChainHash}). Deposit poller will reconcile via the pending_onchain transaction row id=${d.pendingTxId}.`);
      // Still record the tx hash on the pending row so the poller can
      // tie the on-chain funds back to this intent.
      try {
        transactionRepo.updateStatusAndHash(
          d.pendingTxId,
          'pending_onchain',
          onChainHash,
          `${baseMemo} — DB credit FAILED after on-chain send: ${err.message}`,
        );
      } catch { /* ignore */ }
    }
  }

  console.log(`[Escrow] Match #${matchId} resolved: ${winnerAddresses.length} winners${fromDispute ? ' (36h hold)' : ''}. TX: ${onChainHash}`);
  return { disbursements, hash: onChainHash };
}

// ─── On-chain: cancel match → refund all ───────────────────────

async function cancelOnChainMatch(matchId, challengeId, allPlayers, entryAmountUsdc) {
  const playerRows = [];
  const playerAddresses = [];
  const refundAmounts = [];

  for (const player of allPlayers) {
    const wallet = walletRepo.findByUserId(player.user_id);
    if (!wallet) continue;
    playerRows.push({ userId: player.user_id, address: wallet.address });
    playerAddresses.push(wallet.address);
    refundAmounts.push(entryAmountUsdc);
  }

  if (playerAddresses.length === 0) return;

  const baseMemo = `Refund for cancelled match #${matchId}`;

  // Pre-log each refund intent BEFORE the on-chain tx (see
  // disburseWinnings for rationale). If the bot crashes between tx
  // and DB credit, the poller reconciles via these rows.
  for (const p of playerRows) {
    try {
      const row = transactionRepo.create({
        type: 'refund',
        userId: p.userId, challengeId,
        amountUsdc: entryAmountUsdc,
        txHash: null,
        fromAddress: _escrowAddress(),
        toAddress: p.address,
        status: 'pending_onchain',
        memo: `${baseMemo} — tx pending`,
      });
      p.pendingTxId = row.id;
    } catch (err) {
      console.error(`[Escrow] Failed to pre-log refund for user ${p.userId}:`, err.message);
      p.error = err.message;
    }
  }

  // Send the on-chain cancel.
  let onChainHash;
  try {
    const result = await transactionService.invokeContract(
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
    onChainHash = result.hash;
  } catch (err) {
    for (const p of playerRows) {
      if (p.pendingTxId) {
        try {
          transactionRepo.updateStatusAndHash(p.pendingTxId, 'failed', null, `${baseMemo} — on-chain call failed: ${err.message}`);
        } catch { /* ignore */ }
      }
    }
    throw err;
  }

  for (const p of playerRows) {
    if (p.error || !p.pendingTxId) continue;
    try {
      walletRepo.creditAvailable(p.userId, entryAmountUsdc);
      transactionRepo.updateStatusAndHash(p.pendingTxId, 'completed', onChainHash, baseMemo);
    } catch (err) {
      console.error(`[Escrow] CRITICAL: DB credit failed AFTER on-chain refund for user ${p.userId} match #${matchId}: ${err.message}. On-chain funds WERE sent (tx=${onChainHash}). Deposit poller will reconcile via pending_onchain row id=${p.pendingTxId}.`);
      try {
        transactionRepo.updateStatusAndHash(
          p.pendingTxId,
          'pending_onchain',
          onChainHash,
          `${baseMemo} — DB credit FAILED after on-chain send: ${err.message}`,
        );
      } catch { /* ignore */ }
    }
  }

  console.log(`[Escrow] Match #${matchId} cancelled. ${playerAddresses.length} refunded. TX: ${onChainHash}`);
  return { hash: onChainHash };
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
        amountUsdc: net.toString(), txHash: null,
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
