// Pending withdrawal verification sweeper.
//
// Withdrawals that error mid-flight (UserOp was submitted to the
// bundler but the bot didn't see a complete receipt) are flagged as
// `status = 'pending_verification'` with a userOpHash and the sending
// smart account address. The user's DB balance stays debited.
//
// This sweeper polls each pending_verification row periodically and
// resolves it to one of two terminal states:
//
//   - 'completed': on-chain confirms the UserOp landed. Leave DB
//                  debited; mark row with the tx hash; notify admins
//                  of the reconciled withdrawal.
//
//   - 'failed':    after VERIFICATION_WINDOW_MS elapses with no
//                  on-chain sign of the UserOp, credit the user back
//                  via walletRepo.creditAvailable and mark row
//                  failed.
//
// The sweeper is the SOLE path that credits back a verification-
// pending row. Never have the withdraw handler credit back a
// post_submit error — that's the whole reason this file exists.

const { getCdpClient, getSmartAccountFromRef } = require('../base/walletManager');
const { getProvider, getNetwork } = require('../base/connection');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletRepo = require('../database/repositories/walletRepo');
const userRepo = require('../database/repositories/userRepo');
const db = require('../database/db');

// How long to wait before giving up and crediting back. 10 minutes is
// generous — if the UserOp hasn't landed in 10 min it's very unlikely
// to land at all (bundlers drop txs after much shorter windows).
const VERIFICATION_WINDOW_MS = 10 * 60 * 1000;

// How often to poll. 60s balances responsiveness vs CDP API quota.
const DEFAULT_INTERVAL_MS = 60 * 1000;

let sweepInterval = null;
let sweepInProgress = false;

function _getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

/**
 * Query the CDP SDK for the current state of a UserOp.
 * Returns one of:
 *   { state: 'complete', transactionHash }
 *   { state: 'pending'  }
 *   { state: 'failed'   }
 *   { state: 'unknown'  }  — CDP returned an error we can't classify
 */
async function _getUserOpStatus(smartAccountAddress, userOpHash) {
  const cdp = getCdpClient();
  try {
    const op = await cdp.evm.getUserOperation({
      smartAccountAddress,
      userOpHash,
    });
    // CDP statuses we care about (observed strings may vary by SDK
    // version; coerce generously):
    const status = String(op?.status || '').toLowerCase();
    const txHash = op?.transactionHash || null;

    if (status === 'complete' && txHash) return { state: 'complete', transactionHash: txHash };
    if (status === 'complete') return { state: 'pending' }; // complete w/o hash is rare, treat as pending
    if (status === 'failed' || status === 'reverted' || status === 'dropped') return { state: 'failed' };
    if (status === 'pending' || status === 'broadcast' || status === 'submitted' || status === 'sent') return { state: 'pending' };
    return { state: 'unknown' };
  } catch (err) {
    // 404 / not found: the bundler may not have indexed it yet, or
    // it was dropped. Return 'unknown' so the age-based fallback
    // decides.
    return { state: 'unknown' };
  }
}

/**
 * Belt-and-suspenders second check: after a long window with
 * 'unknown' status, ask the chain directly if there's a receipt for
 * this UserOp via the bundler's hash OR for the tx hash if CDP ever
 * gave us one.
 */
async function _chainHasReceipt(txHashOrUserOpHash) {
  if (!txHashOrUserOpHash) return false;
  try {
    const provider = getProvider();
    const receipt = await provider.getTransactionReceipt(txHashOrUserOpHash);
    return !!(receipt && receipt.blockNumber);
  } catch {
    return false;
  }
}

/**
 * Atomically credit the user back and mark the row failed. Wrapped in
 * db.transaction so the credit and the status flip commit together;
 * a crash between them would otherwise leave a failed-status row with
 * no balance restored, or a credit without a paper trail.
 */
const _creditBackAndFailTx = db.transaction((row, memo) => {
  if (row.user_id) {
    walletRepo.creditAvailable(row.user_id, row.amount_usdc);
  }
  transactionRepo.updateStatusAndHash(row.id, 'failed', null, memo);
});

async function _resolveRow(row) {
  const ageMs = Date.now() - new Date(row.created_at).getTime();

  const cdpStatus = await _getUserOpStatus(row.smart_account_address, row.user_op_hash);

  if (cdpStatus.state === 'complete') {
    transactionRepo.updateStatusAndHash(
      row.id,
      'completed',
      cdpStatus.transactionHash,
      `Sweeper: UserOp confirmed on-chain after verification pending`,
    );
    try {
      const { postTransaction } = require('../utils/transactionFeed');
      const u = row.user_id ? userRepo.findById(row.user_id) : null;
      postTransaction({
        type: 'withdrawal',
        username: u?.server_username,
        discordId: u?.discord_id,
        amount: `$${(Number(row.amount_usdc) / 1_000_000).toFixed(2)}`,
        currency: 'USDC',
        toAddress: row.to_address,
        signature: cdpStatus.transactionHash,
        memo: `Sweeper: withdrawal #${row.id} resolved to COMPLETED (UserOp landed after initial wait timeout)`,
      });
    } catch { /* best effort */ }
    console.log(`[WithdrawSweeper] Row ${row.id} → completed (tx ${cdpStatus.transactionHash})`);
    return;
  }

  if (cdpStatus.state === 'failed') {
    // CDP explicitly says the UserOp failed / was dropped. Safe to
    // credit back immediately.
    _creditBackAndFailTx(row, 'Sweeper: UserOp failed/dropped per CDP — credit restored');
    try {
      const { postTransaction } = require('../utils/transactionFeed');
      const u = row.user_id ? userRepo.findById(row.user_id) : null;
      postTransaction({
        type: 'withdraw_sweeper_reconciled',
        username: u?.server_username,
        discordId: u?.discord_id,
        amount: `$${(Number(row.amount_usdc) / 1_000_000).toFixed(2)}`,
        currency: 'USDC',
        memo: `Sweeper: withdrawal #${row.id} failed on-chain — DB balance restored`,
      });
    } catch { /* best effort */ }
    console.log(`[WithdrawSweeper] Row ${row.id} → failed (credited back)`);
    return;
  }

  if (cdpStatus.state === 'pending') {
    // UserOp is still in flight. Check again next cycle.
    console.log(`[WithdrawSweeper] Row ${row.id} still pending (age ${Math.round(ageMs / 1000)}s)`);
    return;
  }

  // 'unknown' — CDP couldn't answer. Only credit back after the
  // verification window has fully elapsed, AND a direct chain lookup
  // also finds no receipt. Two independent sources of "no tx" before
  // we restore the user's balance.
  if (ageMs < VERIFICATION_WINDOW_MS) {
    console.log(`[WithdrawSweeper] Row ${row.id} unknown state (age ${Math.round(ageMs / 1000)}s) — waiting`);
    return;
  }

  const onChain = await _chainHasReceipt(row.user_op_hash);
  if (onChain) {
    transactionRepo.updateStatusAndHash(
      row.id,
      'completed',
      row.user_op_hash,
      `Sweeper: chain receipt found after CDP returned unknown — flipping to completed`,
    );
    console.log(`[WithdrawSweeper] Row ${row.id} → completed (via chain receipt)`);
    return;
  }

  _creditBackAndFailTx(row, `Sweeper: verification window elapsed (${Math.round(ageMs / 1000)}s), CDP unknown, no chain receipt — credit restored`);
  try {
    const { postTransaction } = require('../utils/transactionFeed');
    const u = row.user_id ? userRepo.findById(row.user_id) : null;
    postTransaction({
      type: 'withdraw_sweeper_reconciled',
      username: u?.server_username,
      discordId: u?.discord_id,
      amount: `$${(Number(row.amount_usdc) / 1_000_000).toFixed(2)}`,
      currency: 'USDC',
      memo: `Sweeper: withdrawal #${row.id} timed out (${Math.round(ageMs / 1000)}s), UserOp ${row.user_op_hash} not found on-chain — DB balance restored`,
    });
  } catch { /* best effort */ }
  console.log(`[WithdrawSweeper] Row ${row.id} → failed via timeout (credited back)`);
}

async function sweepOnce() {
  if (sweepInProgress) {
    console.warn('[WithdrawSweeper] Previous cycle still running — skipping');
    return;
  }
  sweepInProgress = true;
  try {
    const rows = transactionRepo.findPendingVerification();
    if (rows.length === 0) return;
    console.log(`[WithdrawSweeper] Checking ${rows.length} pending-verification row(s)`);
    for (const row of rows) {
      try {
        await _resolveRow(row);
      } catch (err) {
        console.error(`[WithdrawSweeper] Error resolving row ${row.id}:`, err.message);
      }
    }
  } finally {
    sweepInProgress = false;
  }
}

function startSweeper(intervalMs = DEFAULT_INTERVAL_MS) {
  if (sweepInterval) {
    console.warn('[WithdrawSweeper] Already running');
    return;
  }
  console.log(`[WithdrawSweeper] Starting (every ${intervalMs / 1000}s, verification window ${VERIFICATION_WINDOW_MS / 1000}s)`);
  // Small initial delay so we don't hammer CDP the instant the bot
  // boots and mid-restart rows exist.
  setTimeout(() => {
    sweepOnce().catch(err => console.error('[WithdrawSweeper] Initial sweep error:', err));
  }, 15_000);
  sweepInterval = setInterval(() => {
    sweepOnce().catch(err => console.error('[WithdrawSweeper] Sweep error:', err));
  }, intervalMs);
}

function stopSweeper() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    console.log('[WithdrawSweeper] Stopped');
  }
}

module.exports = { startSweeper, stopSweeper, sweepOnce, VERIFICATION_WINDOW_MS };
