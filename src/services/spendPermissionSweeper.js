// Pending spend-permission sweeper.
//
// The grant endpoint (webhookServer.js /api/internal/wallet/grant) now
// awaits approveOnChain synchronously and returns the real outcome to
// the browser. But three edge cases can still leave a row stranded as
// status='pending':
//
//   1. The wallet lock was held by another op when the grant arrived,
//      so we returned 202 deferred and didn't try the approval.
//   2. The bot crashed between persisting the row and finishing the
//      on-chain UserOp.
//   3. The user closed the browser tab before the synchronous response
//      came back, but the grant was already persisted server-side.
//   4. CDP/Paymaster threw a transient error and the synchronous attempt
//      bailed out.
//
// In all those cases, the user has signed in their browser but doesn't
// have a wallets row. Without intervention they'd see "Finish setting
// up" forever and need an operator to run a manual node -e command.
//
// This sweeper polls every 60s, finds pending rows older than 60s, and
// retries approveOnChain. Each row is tried up to MAX_ATTEMPTS times
// (tracked via the metadata column) before we post an admin alert and
// stop retrying — by then the failure is structural (paymaster
// allowlist missing, bad signature, etc) and needs operator attention.

const POLL_INTERVAL_MS = 60 * 1000;
const PENDING_AGE_MIN_SECONDS = 60;
const MAX_ATTEMPTS = 5;

let _timer = null;
let _started = false;
let _running = false;
let _discordClient = null;

// In-memory attempt counter: rowId -> attempts. Resets on bot restart;
// not worth a DB column for this — at worst we retry a few extra times
// after a restart, which is harmless.
const _attempts = new Map();

async function _tick() {
  if (_running) return;
  _running = true;

  try {
    const db = require('../database/db');
    const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');
    const walletRepo = require('../database/repositories/walletRepo');
    const spendPermissionService = require('./spendPermissionService');

    const pending = db.prepare(`
      SELECT id, user_id, created_at FROM spend_permissions
      WHERE status = 'pending'
        AND created_at <= datetime('now', '-${PENDING_AGE_MIN_SECONDS} seconds')
      ORDER BY id ASC
    `).all();

    if (pending.length === 0) return;

    console.log(`[SpendPermissionSweeper] Found ${pending.length} stuck pending permission(s) to retry`);

    for (const row of pending) {
      const attempts = (_attempts.get(row.id) || 0) + 1;
      _attempts.set(row.id, attempts);

      if (attempts > MAX_ATTEMPTS) {
        // Don't keep retrying forever. Surface to admin once and skip.
        if (attempts === MAX_ATTEMPTS + 1) {
          await _postAdminAlert(
            `🚨 **Stuck spend permission #${row.id}** for user ${row.user_id}\n` +
            `Failed ${MAX_ATTEMPTS} sweeper retries. Likely structural — check Paymaster allowlist (` +
            `\`approveWithSignature\` selector \`0xb9ffc8e1\` on SpendPermissionManager ` +
            `\`0xf85210B21cC50302F477BA56686d2019dC9b67Ad\`) or RPC config.\n` +
            `Manual retry: \`node -e "require('dotenv').config(); require('./src/database/db'); require('./src/services/spendPermissionService').approveOnChain(${row.id}).then(()=>console.log('ok')).catch(e=>console.error(e))"\``,
          );
        }
        continue;
      }

      // Acquire the wallet lock — the same lock the grant endpoint and
      // depositToEscrow use. If it's held, skip this tick and try next
      // cycle.
      const locked = walletRepo.acquireLock(row.user_id);
      if (!locked) {
        console.log(`[SpendPermissionSweeper] Skipping perm #${row.id} this cycle — wallet lock held`);
        continue;
      }

      try {
        // Re-check status under the lock — another path may have just
        // approved it (grant endpoint, pendingSetup self-heal).
        const fresh = spendPermissionRepo.findById(row.id);
        if (!fresh || fresh.status !== 'pending') {
          _attempts.delete(row.id);
          continue;
        }

        console.log(`[SpendPermissionSweeper] Retrying approveOnChain for perm #${row.id} (attempt ${attempts}/${MAX_ATTEMPTS})`);
        await spendPermissionService.approveOnChain(row.id);
        console.log(`[SpendPermissionSweeper] Recovered perm #${row.id} for user ${row.user_id}`);
        _attempts.delete(row.id);
      } catch (err) {
        console.warn(
          `[SpendPermissionSweeper] Retry ${attempts}/${MAX_ATTEMPTS} failed for perm #${row.id}: ${err.message}`,
        );
      } finally {
        walletRepo.releaseLock(row.user_id);
      }
    }
  } catch (err) {
    console.error('[SpendPermissionSweeper] Tick error:', err.message);
  } finally {
    _running = false;
  }
}

async function _postAdminAlert(content) {
  const channelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  if (!channelId || !_discordClient) return;
  try {
    const ch = _discordClient.channels.cache.get(channelId);
    if (ch) await ch.send({ content, allowedMentions: { users: [] } });
  } catch (err) {
    console.error(`[SpendPermissionSweeper] Failed to post admin alert: ${err.message}`);
  }
}

function start(client) {
  if (_started) return;
  _started = true;
  _discordClient = client;

  console.log(`[SpendPermissionSweeper] Starting (every ${POLL_INTERVAL_MS / 1000}s, retries pending rows >${PENDING_AGE_MIN_SECONDS}s old)`);
  // Run once after a small delay so we don't compete with bot boot.
  setTimeout(() => { _tick().catch(() => {}); }, 30_000);
  _timer = setInterval(() => {
    _tick().catch((err) => console.error('[SpendPermissionSweeper] tick error:', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
  _discordClient = null;
  _attempts.clear();
}

module.exports = { start, stop };
