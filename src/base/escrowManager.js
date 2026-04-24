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

// The escrow contract ABI (JSON format for CDP invokeContract).
// depositFromSpender is the self-custody deposit path: the bot's
// spender Smart Account has already pulled USDC from the user's
// Smart Wallet via SpendPermissionManager.spend, and now calls this
// with source=spender so the contract pulls from there while still
// keying the match record off the real player address.
const ESCROW_ABI_JSON = [
  { name: 'createMatch', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'entryAmount', type: 'uint256' }, { name: 'playerCount', type: 'uint8' }], outputs: [] },
  { name: 'depositToEscrow', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'player', type: 'address' }], outputs: [] },
  { name: 'depositFromSpender', type: 'function', inputs: [{ name: 'matchId', type: 'uint256' }, { name: 'player', type: 'address' }, { name: 'source', type: 'address' }], outputs: [] },
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

/**
 * Self-custody match deposit. Two on-chain steps batched atomically in
 * a single UserOp:
 *
 *   1. SpendPermissionManager.spend(perm, entryAmount) — pulls USDC
 *      out of the user's Coinbase Smart Wallet into the bot's spender
 *      Smart Account. Gated by the per-day allowance the user signed
 *      at /setup; bounded, revocable, user-visible.
 *   2. WagerEscrow.depositFromSpender(matchId, playerAddr, spenderAddr)
 *      — pulls those same USDC out of the spender into the escrow
 *      contract. The match record still keys off the user's real
 *      Smart Wallet address so resolveMatch pays winners back to
 *      their own wallets (never the spender).
 *
 * If the permission is still 'pending' (signed but the grant-time
 * approveWithSignature never landed), an approveWithSignature call is
 * prepended to the batch.
 *
 * Pre-condition: the spender Smart Account must have approved the
 * WagerEscrow contract for USDC at least once. The deploy script
 * for a new WagerEscrow contract does this as part of bring-up.
 *
 * Gasless UserOp through the CDP Paymaster via _sendOwnerTxBatch.
 */
async function depositToEscrow(userId, matchId, challengeId) {
  const walletRecord = walletRepo.findByUserId(userId);
  if (!walletRecord) throw new Error(`No wallet for user ${userId}`);
  console.log(
    `[Escrow] self-custody depositToEscrow: user=${userId} match=${matchId} ` +
    `smartWallet=${walletRecord.address}`,
  );

  // Read entry amount from the on-chain match record (source of truth)
  const provider = getProvider();
  const escrowAbi = ['function getMatch(uint256) view returns (tuple(uint256,uint8,uint8,uint256,bool,bool))'];
  const escrowContract = new ethers.Contract(_escrowAddress(), escrowAbi, provider);
  const matchData = await escrowContract.getMatch(matchId);
  const entryAmount = matchData[0]; // BigInt, smallest units

  if (entryAmount === 0n) {
    throw new Error(`Match ${matchId} does not exist on-chain`);
  }

  // Atomic 2-or-3-call UserOp (audit C3 fix). Sequence:
  //   [optional] SpendPermissionManager.approveWithSignature
  //              (only if the row is still 'pending' — paymaster may
  //              have failed the eager approve at grant time)
  //   SpendPermissionManager.spend(perm, entryAmount)
  //              pulls USDC from user's Smart Wallet → escrow-owner-smart
  //   WagerEscrow.depositFromSpender(matchId, player, source=spender)
  //              pulls those USDC from escrow-owner-smart → WagerEscrow
  //
  // Sending all calls in one UserOp means the ERC-4337 bundler
  // executes them atomically — either every call succeeds and the
  // funds land in the escrow contract, or every call reverts and the
  // user's Smart Wallet balance is unchanged. No orphan state where
  // SPM.spend moved funds to the spender but depositFromSpender never
  // pulled them into escrow.
  const spendPermissionService = require('../services/spendPermissionService');
  let spendSet;
  try {
    spendSet = spendPermissionService.buildSpendCalls(userId, entryAmount);
  } catch (err) {
    console.error(`[Escrow]   buildSpendCalls failed: ${err.code || ''} ${err.message}`);
    throw err;
  }

  // Append the WagerEscrow.depositFromSpender call. All three (or two)
  // go out in one UserOp below.
  const escrowIface = new ethers.Interface([
    'function depositFromSpender(uint256 matchId, address player, address source)',
  ]);
  const depositCallData = escrowIface.encodeFunctionData('depositFromSpender', [
    String(matchId),
    walletRecord.address,
    _ownerAddress(),
  ]);

  const calls = [
    ...spendSet.calls,
    { to: _escrowAddress(), data: depositCallData },
  ];

  console.log(
    `[Escrow]   submitting atomic UserOp: ${calls.length} calls ` +
    `(wasPending=${spendSet.wasPending})`,
  );

  let hash;
  try {
    hash = await transactionService._sendOwnerTxBatch(calls);
  } catch (err) {
    // If pre_submit, funds untouched — safe to bubble up and let
    // match-start's catch path DB-unhold / refund.
    // If post_submit, the UserOp is in flight; caller must treat the
    // match as pending verification. The pendingWithdrawSweeper
    // handles this class by polling getUserOperation.
    console.error(
      `[Escrow]   self-custody deposit UserOp failed ` +
      `(stage=${err.stage || 'unknown'}): ${err.message}`,
    );
    throw err;
  }

  // Success — reconcile DB state. If the permission was pending and
  // the batched approveWithSignature just landed, flip the DB row to
  // 'approved' so future spends skip the approve leg.
  if (spendSet.wasPending) {
    const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');
    try {
      spendPermissionRepo.markApprovedAndSupersedeOthers(spendSet.permissionId, hash);
    } catch (markErr) {
      console.warn(`[Escrow]   markApproved failed (non-fatal): ${markErr.message}`);
    }
  }

  // Zero out held balance in DB (funds now in escrow contract). Mirror
  // the legacy path — balance_held drops by entryAmount.
  const freshWallet = walletRepo.findByUserId(userId);
  const newHeld = (BigInt(freshWallet.balance_held) - entryAmount).toString();
  walletRepo.updateBalance(userId, {
    balanceAvailable: freshWallet.balance_available,
    balanceHeld: newHeld,
  });

  transactionRepo.create({
    type: TRANSACTION_TYPE.ESCROW_IN,
    userId, challengeId, amountUsdc: entryAmount.toString(),
    txHash: hash,
    fromAddress: walletRecord.address,
    toAddress: _escrowAddress(),
    status: 'completed',
    memo: `Escrow deposit (self-custody, atomic) for match #${matchId}`,
  });

  console.log(`[Escrow] User ${userId} deposited to match #${matchId} (self-custody atomic): ${hash}`);
  return { hash };
}

// ─── On-chain: transfer all players' USDC to escrow ────────────

async function transferToEscrow(matchId, challengeId, allPlayers, entryAmountUsdc, playerCount) {
  console.log(`[Escrow] transferToEscrow: match=${matchId} challenge=${challengeId} entry=${entryAmountUsdc} players=${playerCount}`);
  console.log(`[Escrow]   player IDs: ${allPlayers.map(p => p.user_id).join(', ')}`);

  // Pre-flight on-chain balance check. For self-custody users the DB
  // `balance_available` can drift from reality — the user can drain
  // their Smart Wallet via `/withdraw` or any external transfer and
  // the bot won't know until a deposit-poller reconcile (every 30s).
  // If we submit the match-start batch without checking, a drained
  // player's SPM.spend reverts — which aborts the loop mid-way and
  // leaves the on-chain match in a partial-deposit state requiring
  // cancel + per-player refund. Cheaper to fail fast here: if any
  // player lacks on-chain funds, throw before createMatch so the
  // caller can cancel cleanly with no on-chain cleanup needed.
  const provider = getProvider();
  const usdcCheck = new ethers.Contract(
    walletManager.USDC_CONTRACT,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  );
  const needed = BigInt(entryAmountUsdc);
  for (const player of allPlayers) {
    const w = walletRepo.findByUserId(player.user_id);
    if (!w) throw new Error(`No wallet for user ${player.user_id}`);
    const bal = await usdcCheck.balanceOf(w.address);
    if (bal < needed) {
      throw new Error(
        `Player ${player.user_id} has insufficient on-chain USDC ` +
        `(have ${bal.toString()}, need ${needed.toString()}). ` +
        `Match not started.`,
      );
    }
  }

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

  // Audit C3 second half: only include players who ACTUALLY have an
  // on-chain deposit in this match. A self-custody deposit that failed
  // mid-UserOp (thanks to the atomic batching above, this shouldn't
  // happen — but defense in depth) would leave the player with DB
  // balance_held elevated but no on-chain hasDeposited[player]=true.
  // Including them in cancelMatch overcounts totalRefund vs the
  // contract's totalDeposited, causing the on-chain cancel to revert
  // entirely — which strands every player's refund, not just the one
  // who failed to deposit. Filter them out, DB-unhold them separately.
  const provider = getProvider();
  const escrowCheckAbi = [
    'function hasDeposited(uint256, address) view returns (bool)',
  ];
  const escrowContract = new ethers.Contract(_escrowAddress(), escrowCheckAbi, provider);

  const dbOnlyUnholds = []; // players held in DB but never on-chain — credit back off-chain

  for (const player of allPlayers) {
    const wallet = walletRepo.findByUserId(player.user_id);
    if (!wallet) continue;

    let onChain = false;
    try {
      onChain = await escrowContract.hasDeposited(matchId, wallet.address);
    } catch (err) {
      console.warn(`[Escrow] cancelOnChainMatch: hasDeposited check failed for user ${player.user_id}: ${err.message}. Assuming on-chain (safer for refund).`);
      onChain = true;
    }

    if (onChain) {
      playerRows.push({ userId: player.user_id, address: wallet.address });
      playerAddresses.push(wallet.address);
      refundAmounts.push(entryAmountUsdc);
    } else {
      console.log(`[Escrow] cancelOnChainMatch: user ${player.user_id} is DB-held but NOT on-chain; DB-unholding only.`);
      dbOnlyUnholds.push({ userId: player.user_id, amount: entryAmountUsdc });
    }
  }

  // Credit back DB-only unholds immediately. No contract call — their
  // funds never left the DB in real terms (the match-start UserOp
  // reverted atomically, so on-chain state is unchanged for them).
  for (const u of dbOnlyUnholds) {
    try {
      walletRepo.creditAvailable(u.userId, u.amount);
      transactionRepo.create({
        type: 'refund',
        userId: u.userId, challengeId,
        amountUsdc: u.amount,
        txHash: null,
        fromAddress: null,
        toAddress: null,
        status: 'completed',
        memo: `DB-unhold for cancelled match #${matchId} (player never deposited on-chain)`,
      });
    } catch (err) {
      console.error(`[Escrow] cancelOnChainMatch: DB-unhold failed for user ${u.userId}: ${err.message}`);
    }
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
  createOnChainMatch,
  depositToEscrow,
  transferToEscrow,
  disburseWinnings,
  cancelOnChainMatch,
  refundAll,
};
