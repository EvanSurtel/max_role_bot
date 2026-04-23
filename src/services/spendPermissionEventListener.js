// SpendPermissionManager event listener.
//
// The SPM contract emits an event whenever a permission is revoked —
// either by the user signing revoke() from their wallet (the canonical
// user-initiated revoke path) or by us calling revokeAsSpender() from
// the backend. We need to hear both so the DB never lies about which
// permissions are actually live.
//
// Without this listener, a user-revoked permission would still look
// 'approved' in our DB until the next spendForUser() call attempted an
// on-chain spend() that reverted — wasting a UserOp each time and, in
// match-start context, failing a match entry after the user thinks
// they've joined.
//
// Implementation notes:
//   - Uses ethers.Contract with a filter on the `spender` topic set to
//     our escrow-owner-smart address, so we don't receive every revoke
//     for every project on Base.
//   - Polls via the underlying FallbackProvider — ethers' provider.on
//     handles the per-block reconciliation; no manual block cursors.
//   - On event, look up the permission by its hash. If we don't have
//     a row for it (e.g. user granted to us on a different env and
//     never migrated), log + drop.

const { ethers } = require('ethers');
const { getProvider } = require('../base/connection');
const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');

// Same address as spendPermissionService — repeated here to avoid a
// circular require (service → repo → listener → service).
const SPEND_PERMISSION_MANAGER_ADDRESS = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';

// Event shape matches the deployed SpendPermissionManager on Base.
// Verified against https://basescan.org/address/0xf85210B21cC50302F477BA56686d2019dC9b67Ad#code
// The contract also emits SpendPermissionApproved and SpendPermissionUsed;
// we only act on the revoke here — approved is written by our own
// approveOnChain path (which updates DB synchronously with the tx hash),
// and used() is informational only.
const EVENT_ABI = [
  'event SpendPermissionRevoked(bytes32 indexed hash, address indexed account, address indexed spender)',
];

let _contract = null;
let _started = false;

function start() {
  if (_started) return;
  _started = true;

  // CDP_OWNER_ADDRESS is the canonical env var for escrow-owner-smart
  // across the rest of the bot (see escrowManager.js `_ownerAddress`).
  // Keep the _SMART_ADDRESS / BOT_SPENDER fallbacks for forward-compat
  // if we ever split the naming, but CDP_OWNER_ADDRESS is what's
  // actually in .env today.
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

  _contract = new ethers.Contract(SPEND_PERMISSION_MANAGER_ADDRESS, EVENT_ABI, provider);

  // Filter by spender — Base sees SPM revokes for every project, not
  // just ours, so filtering server-side via the indexed topic keeps
  // the event stream relevant.
  const filter = _contract.filters.SpendPermissionRevoked(null, null, spender);

  _contract.on(filter, (hash, account, evSpender, eventLog) => {
    try {
      const permissionHash = String(hash).toLowerCase();
      const row = spendPermissionRepo.findByHash(permissionHash);
      if (!row) {
        console.log(
          `[SpendPermissionEventListener] Revoke for unknown permission ${permissionHash} (account=${account}) — skipping.`,
        );
        return;
      }
      if (row.status === 'revoked') return; // already reflected
      const txHash = eventLog?.log?.transactionHash || eventLog?.transactionHash || null;
      spendPermissionRepo.setRevoked(row.id, txHash);
      console.log(
        `[SpendPermissionEventListener] Marked permission ${row.id} revoked (user=${row.user_id}, tx=${txHash}).`,
      );
    } catch (err) {
      console.error('[SpendPermissionEventListener] handler error:', err.message);
    }
  });

  console.log(`[SpendPermissionEventListener] Watching SPM revokes for spender ${spender}`);
}

function stop() {
  if (_contract) {
    try { _contract.removeAllListeners(); } catch { /* best-effort */ }
    _contract = null;
  }
  _started = false;
}

module.exports = { start, stop };
