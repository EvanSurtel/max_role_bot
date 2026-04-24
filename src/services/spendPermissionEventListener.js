// SpendPermissionManager event listener.
//
// The SPM contract emits an event whenever a permission is revoked —
// either by the user signing revoke() from their wallet (the canonical
// user-initiated revoke path) or by us calling revokeAsSpender() from
// the backend. We want to hear both so the DB never lies about which
// permissions are actually live.
//
// Without this listener, a user-revoked permission would still look
// 'approved' in our DB until the next spendForUser() call attempted an
// on-chain spend() that reverted — wasting a UserOp each time and, in
// match-start context, failing a match entry after the user thinks
// they've joined.
//
// Implementation notes:
//   - Uses a bounded-range eth_getLogs poll (≤10 blocks at a time) so
//     free-tier Alchemy plans, which cap eth_getLogs range at 10
//     blocks, don't blow up. Previously used ethers' provider.on() which
//     internally does a single eth_getLogs over the entire polling gap
//     and fails on free-tier providers the moment the bot falls more
//     than 10 blocks behind the head.
//   - Filter is scoped by the `spender` topic set to our
//     escrow-owner-smart address so we only see revokes for OUR grants.
//   - Resilient: a single failed poll logs and retries; the cursor
//     doesn't advance until the query succeeds so no events are lost.
//
// Disable entirely by setting ENABLE_SPM_LISTENER=false (default: on).
// User-initiated revokes are still caught lazily — next failed spend
// surfaces NO_ACTIVE_PERMISSION / on-chain revert — so losing this
// listener is not catastrophic, just less graceful.

const { ethers } = require('ethers');
const { getProvider } = require('../base/connection');
const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');

const SPEND_PERMISSION_MANAGER_ADDRESS = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';

// SpendPermissionRevoked(bytes32 indexed hash, address indexed account, address indexed spender)
// Topic[0] = keccak256 of the event signature. Precomputed to avoid
// needing a Contract wrapper just to resolve it.
const REVOKED_TOPIC =
  ethers.id('SpendPermissionRevoked(bytes32,address,address)');

const IFACE = new ethers.Interface([
  'event SpendPermissionRevoked(bytes32 indexed hash, address indexed account, address indexed spender)',
]);

// Alchemy free tier caps eth_getLogs at 10 blocks. Base's public RPC
// has its own limits. Pick a conservatively small chunk.
const MAX_CHUNK = 10;
// Poll cadence. Base block time is ~2s, so 10s polls let us stay
// roughly in sync while covering ~5 blocks per cycle (well under MAX_CHUNK).
const POLL_INTERVAL_MS = 10_000;

let _started = false;
let _timer = null;
let _lastBlock = null;

function _enabled() {
  const raw = (process.env.ENABLE_SPM_LISTENER || 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

async function _pollOnce(provider, spenderLower) {
  const head = await provider.getBlockNumber();
  if (_lastBlock == null) {
    // First run — start from head. Historical revokes (before the bot
    // came online) are handled by the lazy-reconcile path (next
    // failed spend catches it). Scanning all of history on boot would
    // cost far more than it's worth.
    _lastBlock = head;
    return;
  }
  if (head <= _lastBlock) return;

  let from = _lastBlock + 1;
  const finalTo = head;

  while (from <= finalTo) {
    const to = Math.min(from + MAX_CHUNK - 1, finalTo);
    let logs;
    try {
      logs = await provider.getLogs({
        address: SPEND_PERMISSION_MANAGER_ADDRESS,
        fromBlock: from,
        toBlock: to,
        topics: [
          REVOKED_TOPIC,
          null, // hash (indexed) — any
          null, // account (indexed) — any
          ethers.zeroPadValue(spenderLower, 32), // spender (indexed) = ours
        ],
      });
    } catch (err) {
      // Don't advance _lastBlock — we'll retry the same range next tick.
      console.warn(`[SpendPermissionEventListener] getLogs ${from}→${to} failed: ${err.shortMessage || err.message}`);
      return;
    }

    for (const log of logs) {
      try {
        const parsed = IFACE.parseLog({ topics: log.topics, data: log.data });
        const permissionHash = String(parsed.args.hash).toLowerCase();
        const row = spendPermissionRepo.findByHash(permissionHash);
        if (!row) {
          console.log(
            `[SpendPermissionEventListener] Revoke for unknown permission ${permissionHash} (account=${parsed.args.account}) — skipping.`,
          );
          continue;
        }
        if (row.status === 'revoked') continue;
        spendPermissionRepo.setRevoked(row.id, log.transactionHash || null);
        console.log(
          `[SpendPermissionEventListener] Marked permission ${row.id} revoked (user=${row.user_id}, tx=${log.transactionHash}).`,
        );
      } catch (handlerErr) {
        console.error('[SpendPermissionEventListener] handler error:', handlerErr.message);
      }
    }

    _lastBlock = to;
    from = to + 1;
  }
}

function start() {
  if (_started) return;
  _started = true;

  if (!_enabled()) {
    console.log('[SpendPermissionEventListener] Disabled via ENABLE_SPM_LISTENER=false.');
    return;
  }

  const spender =
    process.env.CDP_OWNER_ADDRESS ||
    process.env.ESCROW_OWNER_SMART_ADDRESS ||
    process.env.NEXT_PUBLIC_BOT_SPENDER_ADDRESS;
  if (!spender) {
    console.warn(
      '[SpendPermissionEventListener] CDP_OWNER_ADDRESS not set — skipping revoke listener. User-initiated revokes will only be caught on the next failed spend.',
    );
    return;
  }

  let provider;
  try {
    provider = getProvider();
  } catch (err) {
    console.warn(`[SpendPermissionEventListener] No Base provider available: ${err.message}. Listener disabled.`);
    return;
  }

  const spenderLower = String(spender).toLowerCase();

  console.log(`[SpendPermissionEventListener] Watching SPM revokes for spender ${spender} (poll every ${POLL_INTERVAL_MS}ms, max ${MAX_CHUNK} blocks/chunk)`);

  // First tick initializes _lastBlock to current head; subsequent
  // ticks scan forward in 10-block chunks.
  const tick = () => {
    _pollOnce(provider, spenderLower).catch((err) => {
      console.warn(`[SpendPermissionEventListener] poll error: ${err.message}`);
    });
  };
  tick();
  _timer = setInterval(tick, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _started = false;
  _lastBlock = null;
}

module.exports = { start, stop };
