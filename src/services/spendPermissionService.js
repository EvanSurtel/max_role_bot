// SpendPermission backend service.
//
// Backend half of the Coinbase Smart Wallet + Spend Permission self-
// custody migration. The browser surface (wallet.rank.gg or wherever)
// has the user sign an EIP-712 SpendPermission via their passkey;
// this module:
//
//   1. accepts the signed permission, validates it, persists it
//   2. lifts it on-chain via SpendPermissionManager.approveWithSignature
//   3. exposes spend(userId, usdcAmount) → pulls funds from the
//      user's Smart Wallet to our backend Smart Account (escrow-owner-smart),
//      from there into the WagerEscrow contract
//   4. exposes revoke(userId) for both user-initiated and admin paths
//
// Both approve and spend are gasless UserOps — they go through CDP's
// Paymaster via our existing escrow-owner-smart Smart Account, so we
// reuse all the gasless plumbing already in transactionService.js.
//
// Contract: SpendPermissionManager singleton on Base (mainnet + sepolia)
//   address: 0xf85210B21cC50302F477BA56686d2019dC9b67Ad
//   source:  node_modules/@coinbase/cdp-sdk/_types/spend-permissions/constants.d.ts

const { ethers } = require('ethers');
const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const { getProvider, getNetwork } = require('../base/connection');

// SpendPermissionManager singleton on Base mainnet + sepolia. Same
// address (deterministic deploy). Source of truth: the CDP SDK
// constants file at node_modules/@coinbase/cdp-sdk/_cjs/spend-permissions/constants.js
// (we don't import from there because the package doesn't expose
// that subpath via its exports field — would break on SDK upgrade).
const SPEND_PERMISSION_MANAGER_ADDRESS = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Minimal ABI fragment — only the functions we actually call. Defining
// inline so we're not coupled to where the CDP SDK chooses to surface
// the full ABI in any given version. The struct shape MUST match the
// deployed contract exactly; verify against
// https://basescan.org/address/0xf85210B21cC50302F477BA56686d2019dC9b67Ad#code
// if there's ever doubt.
const SPM_TUPLE_TYPE = 'tuple(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData)';
const SPM_MINIMAL_ABI = [
  `function approveWithSignature(${SPM_TUPLE_TYPE} permission, bytes signature)`,
  `function spend(${SPM_TUPLE_TYPE} permission, uint160 value)`,
  `function revoke(${SPM_TUPLE_TYPE} permission)`,
  `function revokeAsSpender(${SPM_TUPLE_TYPE} permission)`,
  `function getHash(${SPM_TUPLE_TYPE} permission) view returns (bytes32)`,
  `function isApproved(${SPM_TUPLE_TYPE} permission) view returns (bool)`,
  `function isRevoked(${SPM_TUPLE_TYPE} permission) view returns (bool)`,
];
const _spmIface = new ethers.Interface(SPM_MINIMAL_ABI);

// EIP-712 SpendPermission type — must match the deployed contract's
// expected struct exactly. Source: @coinbase/cdp-sdk types +
// coinbase/spend-permissions repo.
const SPEND_PERMISSION_TYPES = {
  SpendPermission: [
    { name: 'account',   type: 'address' },
    { name: 'spender',   type: 'address' },
    { name: 'token',     type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period',    type: 'uint48'  },
    { name: 'start',     type: 'uint48'  },
    { name: 'end',       type: 'uint48'  },
    { name: 'salt',      type: 'uint256' },
    { name: 'extraData', type: 'bytes'   },
  ],
};

function _eip712Domain(chainId) {
  return {
    name: 'Spend Permission Manager',
    version: '1',
    chainId,
    verifyingContract: SPEND_PERMISSION_MANAGER_ADDRESS,
  };
}

function _chainId() {
  return getNetwork() === 'sepolia' ? 84532 : 8453;
}

/**
 * Compute the SpendPermissionManager hash of a struct. We use this as
 * the natural dedupe key + as the argument to revoke(), and it lets us
 * cross-check the on-chain state.
 *
 * Verified against the contract by calling SpendPermissionManager.getHash
 * the first time a permission is approved on each environment — if the
 * local computation diverges, surface a loud error.
 */
function computePermissionHash(perm, chainId = _chainId()) {
  // ethers v6 TypedDataEncoder produces the EIP-712 struct hash
  return ethers.TypedDataEncoder.hash(
    _eip712Domain(chainId),
    SPEND_PERMISSION_TYPES,
    _normalizePermission(perm),
  );
}

/**
 * Coerce field types to what ethers + the contract expect. Browser
 * sometimes sends BigInts as strings; sometimes addresses unchecksummed.
 */
function _normalizePermission(p) {
  return {
    account:   ethers.getAddress(p.account),
    spender:   ethers.getAddress(p.spender),
    token:     ethers.getAddress(p.token),
    allowance: BigInt(p.allowance),
    period:    Number(p.period),
    start:     Number(p.start),
    end:       Number(p.end),
    salt:      BigInt(p.salt),
    extraData: p.extraData || '0x',
  };
}

/**
 * Verify the user's EIP-712 signature over the permission, against
 * their Smart Wallet address (perm.account). Smart Wallet signatures
 * are ERC-1271 (contract-based) and may be ERC-6492-wrapped if the
 * wallet hasn't been deployed on-chain yet. viem's verifyTypedData
 * handles all three cases — raw ECDSA, deployed-wallet ERC-1271, and
 * counterfactual-wallet ERC-6492 — via a universal-validator call
 * against a public Base client. Returns { valid: boolean }.
 *
 * Synchronous (i.e. non-deferred) verification is the audit fix for
 * C1/H3: if a malicious web caller submits a grant with a forged
 * signature, we MUST reject it before writing the row or flipping
 * wallet.address — otherwise an attacker who knows / steals the
 * shared secret can bind arbitrary Smart Wallet addresses to any
 * Discord user and steal future deposits.
 */
async function verifySignature(perm, signature) {
  const norm = _normalizePermission(perm);
  const { createPublicClient, http } = require('viem');
  const { base, baseSepolia } = require('viem/chains');
  const viemUtils = require('viem/utils');

  const chain = getNetwork() === 'sepolia' ? baseSepolia : base;
  const transportUrl =
    process.env.BASE_RPC_URL ||
    (chain === baseSepolia ? 'https://sepolia.base.org' : 'https://mainnet.base.org');

  const client = createPublicClient({ chain, transport: http(transportUrl) });

  const domain = {
    name: 'Spend Permission Manager',
    version: '1',
    chainId: chain.id,
    verifyingContract: SPEND_PERMISSION_MANAGER_ADDRESS,
  };

  // viem's verifyTypedData calls the universal signature validator
  // under the hood (ERC-6492 deploy-and-validate pattern), so it
  // works for both deployed Smart Wallets and counterfactual ones.
  try {
    const valid = await client.verifyTypedData({
      address: norm.account,
      domain,
      types: SPEND_PERMISSION_TYPES,
      primaryType: 'SpendPermission',
      message: {
        account: norm.account,
        spender: norm.spender,
        token: norm.token,
        allowance: norm.allowance,
        period: norm.period,
        start: norm.start,
        end: norm.end,
        salt: norm.salt,
        extraData: norm.extraData,
      },
      signature,
    });
    return { valid: Boolean(valid) };
  } catch (err) {
    // verifyTypedData throws on malformed inputs (bad hex, bad
    // address, etc). Treat as invalid rather than leaking the error.
    console.warn(`[SpendPermission] verifyTypedData threw: ${err.message}`);
    return { valid: false };
  }
}

/**
 * Persist a user-signed SpendPermission. Called from the web surface
 * after the user signs in their browser. Returns the row id.
 *
 * Idempotent on permission_hash — if a row already exists for this
 * exact hash, return the existing row instead of inserting again.
 */
async function recordUserGrant({ userId, permission, signature }) {
  const norm = _normalizePermission(permission);
  const hash = computePermissionHash(norm);

  const existing = spendPermissionRepo.findByHash(hash);
  if (existing) return existing;

  const verification = await verifySignature(norm, signature);
  if (!verification.valid) {
    throw new Error('SpendPermission signature failed verification');
  }

  const row = spendPermissionRepo.create({
    userId,
    account: norm.account,
    spender: norm.spender,
    token: norm.token,
    allowance: norm.allowance.toString(),
    period: norm.period,
    startTs: norm.start,
    endTs: norm.end,
    salt: norm.salt.toString(),
    extraData: norm.extraData,
    signature,
    permissionHash: hash,
  });
  return row;
}

/**
 * Convert a stored DB row back into the struct the SPM contract expects.
 * BigInt-typed fields (allowance, salt) come out of SQLite as strings;
 * the contract ABI expects native BigInt for uint160/uint256.
 */
function _rowToStruct(row) {
  return {
    account:   ethers.getAddress(row.account),
    spender:   ethers.getAddress(row.spender),
    token:     ethers.getAddress(row.token),
    allowance: BigInt(row.allowance),
    period:    Number(row.period),
    start:     Number(row.start_ts),
    end:       Number(row.end_ts),
    salt:      BigInt(row.salt),
    extraData: row.extra_data || '0x',
  };
}

/**
 * Lift a pending SpendPermission on-chain via approveWithSignature.
 * Called either:
 *   - immediately after recordUserGrant (eager) so the first spend works
 *   - lazily on the first spend() attempt (cheaper for grants the user
 *     never actually exercises)
 *
 * Uses our escrow-owner-smart Smart Account as the sender — UserOp
 * sponsored by CDP Paymaster, no ETH required. We can't use
 * cdp.evm.createSpendPermission here because it submits `approve` from
 * the user's account (only works for CDP-managed accounts); we need
 * `approveWithSignature(struct, sig)` called from our spender so the
 * user's prior off-chain signature is what authorizes the on-chain
 * approval.
 *
 * Idempotent: if status is already 'approved', returns the row.
 */
async function approveOnChain(rowId) {
  const row = spendPermissionRepo.findById(rowId);
  if (!row) throw new Error(`spend_permission ${rowId} not found`);
  if (row.status === 'approved') return row;
  if (row.status === 'revoked' || row.status === 'expired' || row.status === 'superseded') {
    throw new Error(`Cannot approve spend_permission ${rowId} — status is ${row.status}`);
  }

  const struct = _rowToStruct(row);

  // On-chain idempotency check FIRST. If a previous attempt's UserOp
  // landed on-chain but our bot didn't observe the confirmation (CDP
  // wait timeout = post_submit error class, bot crash mid-confirm,
  // network drop), the permission is already approved at the contract
  // level. Submitting another approveWithSignature for the same struct
  // would revert ("already approved") and the sweeper would loop
  // forever. Read isApproved first; if true, just reconcile our DB +
  // wallet row and return.
  try {
    const provider = getProvider();
    const spmContract = new ethers.Contract(
      SPEND_PERMISSION_MANAGER_ADDRESS,
      ['function isApproved(tuple(address account, address spender, address token, uint160 allowance, uint48 period, uint48 start, uint48 end, uint256 salt, bytes extraData) permission) view returns (bool)'],
      provider,
    );
    const alreadyApproved = await spmContract.isApproved(struct);
    if (alreadyApproved) {
      console.log(`[SpendPermission] Row ${rowId} already approved on-chain (recovered from prior post_submit) — reconciling DB without resubmitting`);
      spendPermissionRepo.markApprovedAndSupersedeOthers(rowId, null);
      try {
        const approvedRow = spendPermissionRepo.findById(rowId);
        _flipWalletToSelfCustody(approvedRow);
      } catch (flipErr) {
        console.error(`[SpendPermission] Wallet flip during on-chain reconcile failed for row ${rowId}: ${flipErr.message}`);
      }
      return spendPermissionRepo.findById(rowId);
    }
  } catch (preCheckErr) {
    // isApproved read failed — log and proceed with the normal submit
    // path. Worst case we'll catch the revert below and surface the
    // same error message we always did.
    console.warn(`[SpendPermission] isApproved pre-check failed for row ${rowId}: ${preCheckErr.message} — proceeding with submit`);
  }

  const data = _spmIface.encodeFunctionData('approveWithSignature', [struct, row.signature]);

  const { _sendOwnerTx } = require('../base/transactionService');
  let txHash;
  try {
    txHash = await _sendOwnerTx(SPEND_PERMISSION_MANAGER_ADDRESS, data);
  } catch (err) {
    console.error(`[SpendPermission] approveWithSignature failed for row ${rowId}: ${err.message}`);
    throw err;
  }

  spendPermissionRepo.markApprovedAndSupersedeOthers(rowId, txHash);
  console.log(`[SpendPermission] Row ${rowId} approved on-chain (tx ${txHash})`);

  // Reconcile the user's wallets row to self-custody. This was
  // previously done only in webhookServer.js's grant endpoint callback,
  // which meant a manual retry of approveOnChain (bypassing the HTTP
  // grant path) left the permission 'approved' on-chain but the user
  // had no wallets row — every "View Wallet" click surfaced the
  // "finish setting up your wallet" prompt even though setup was done.
  // Moving it here makes approveOnChain the single source of truth:
  // any code path that flips a permission to 'approved' also flips
  // the wallet.
  try {
    const approvedRow = spendPermissionRepo.findById(rowId);
    _flipWalletToSelfCustody(approvedRow);
  } catch (flipErr) {
    console.error(
      `[SpendPermission] Wallet flip failed for user ${row.user_id} after row ${rowId} approved: ${flipErr.message}. ` +
      'Permission is still approved on-chain; a manual reconcile can insert the wallet row.',
    );
  }

  return spendPermissionRepo.findById(rowId);
}

/**
 * After a permission lands on-chain, update the user's wallets row
 * to point at the Smart Wallet and mark it self-custody. Used as a
 * side-effect of approveOnChain so it runs whether the approve came
 * from the HTTP grant endpoint or from a manual retry.
 *
 * Accepts an already-approved spend_permissions row (with .user_id
 * and .account set). Idempotent: if the wallet already has the
 * correct type + address, the UPDATE is a no-op.
 */
function _flipWalletToSelfCustody(row) {
  if (!row || !row.user_id || !row.account) {
    throw new Error('_flipWalletToSelfCustody: row.user_id and row.account required');
  }
  const walletRepo = require('../database/repositories/walletRepo');
  const db = require('../database/db');
  const smartAddr = row.account;
  const smartLower = String(smartAddr).toLowerCase();

  // Wrap in BEGIN IMMEDIATE so two concurrent approveOnChain calls
  // (e.g. grant endpoint + sweeper racing on a brand-new user) can't
  // both see existing=null and both call walletRepo.create — the
  // second would throw a UNIQUE constraint violation. With the
  // transaction wrapper, the second caller's findByUserId reads the
  // row the first caller just inserted.
  const flipTx = db.transaction(() => {
    const existing = walletRepo.findByUserId(row.user_id);
    if (existing) {
      // Legacy CDP user upgrading to self-custody, OR an already-flipped
      // row. Either way, update-in-place. COALESCE preserves the old
      // CDP address in legacy_cdp_address so the fund-migration script
      // can sweep from it.
      db.prepare(`
        UPDATE wallets
        SET wallet_type = 'coinbase_smart_wallet',
            smart_wallet_address = @smart,
            legacy_cdp_address = COALESCE(legacy_cdp_address, address),
            address = @smart,
            migrated_at = COALESCE(migrated_at, datetime('now'))
        WHERE user_id = @userId
      `).run({ smart: smartLower, userId: row.user_id });
      return;
    }
    // Brand-new self-custody user with no prior wallet row. accountRef
    // is required non-null on the current schema (legacy NOT NULL from
    // XRP/CDP eras); passing 'self-custody' as a sentinel satisfies the
    // constraint and clearly marks the row as non-CDP on inspection.
    walletRepo.create({
      userId: row.user_id,
      address: smartAddr,
      accountRef: 'self-custody',
      smartAccountRef: null,
    });
    db.prepare(`
      UPDATE wallets
      SET wallet_type = 'coinbase_smart_wallet',
          smart_wallet_address = @smart,
          migrated_at = datetime('now')
      WHERE user_id = @userId
    `).run({ smart: smartLower, userId: row.user_id });
  });
  flipTx.immediate();
}

/**
 * Pull `amountUsdcSmallest` USDC from the user's Smart Wallet to our
 * spender address (escrow-owner-smart) via SpendPermissionManager.spend.
 * Returns the on-chain tx hash on success.
 *
 * Lazy on-chain approve: if the active permission is still 'pending'
 * (signed by user, not yet lifted), we approve first then spend. Both
 * UserOps are gasless via Paymaster.
 *
 * Errors:
 *   NO_ACTIVE_PERMISSION   — user has no usable permission row
 *   ALLOWANCE_EXCEEDED     — request > the per-period cap
 *   On-chain revert (e.g. period exhausted) — SPM contract error
 *     bubbles up; caller should distinguish.
 */
/**
 * Build the list of SPM calls needed to pull `amountUsdcSmallest` from
 * the user's Smart Wallet, WITHOUT submitting any UserOp. Returns:
 *   { calls: [{to, data}, ...], permissionId: number }
 *
 * - If the permission is already 'approved' on-chain, returns a single
 *   spend() call.
 * - If the permission is still 'pending' (signed but the bot's
 *   approveWithSignature never landed), returns [approveWithSignature,
 *   spend] so the batch covers both in one atomic UserOp.
 *
 * This is what escrowManager's self-custody deposit uses so it can
 * fuse our SPM pull + WagerEscrow.depositFromSpender into a single
 * UserOp — eliminating the "SPM.spend succeeded but depositFromSpender
 * failed, USDC orphaned at the spender" failure mode (audit C3).
 *
 * Throws NO_ACTIVE_PERMISSION / ALLOWANCE_EXCEEDED just like spendForUser.
 */
function buildSpendCalls(userId, amountUsdcSmallest) {
  const active = spendPermissionRepo.findActiveForUser(userId)
    || spendPermissionRepo.findAllForUser(userId).find(r => r.status === 'pending');

  if (!active) {
    const e = new Error('No active SpendPermission for user');
    e.code = 'NO_ACTIVE_PERMISSION';
    throw e;
  }
  if (BigInt(amountUsdcSmallest) > BigInt(active.allowance)) {
    const e = new Error(`Spend ${amountUsdcSmallest} exceeds permission allowance ${active.allowance}`);
    e.code = 'ALLOWANCE_EXCEEDED';
    throw e;
  }

  const struct = _rowToStruct(active);
  const calls = [];

  if (active.status === 'pending') {
    calls.push({
      to: SPEND_PERMISSION_MANAGER_ADDRESS,
      data: _spmIface.encodeFunctionData('approveWithSignature', [struct, active.signature]),
    });
  }

  calls.push({
    to: SPEND_PERMISSION_MANAGER_ADDRESS,
    data: _spmIface.encodeFunctionData('spend', [struct, BigInt(amountUsdcSmallest)]),
  });

  return { calls, permissionId: active.id, wasPending: active.status === 'pending' };
}

async function spendForUser(userId, amountUsdcSmallest) {
  const active = spendPermissionRepo.findActiveForUser(userId)
    || spendPermissionRepo.findAllForUser(userId).find(r => r.status === 'pending');

  if (!active) {
    const e = new Error('No active SpendPermission for user');
    e.code = 'NO_ACTIVE_PERMISSION';
    throw e;
  }
  if (BigInt(amountUsdcSmallest) > BigInt(active.allowance)) {
    const e = new Error(`Spend ${amountUsdcSmallest} exceeds permission allowance ${active.allowance}`);
    e.code = 'ALLOWANCE_EXCEEDED';
    throw e;
  }

  // Lazy approve if needed — first spend kicks the on-chain approval.
  if (active.status === 'pending') {
    await approveOnChain(active.id);
  }

  const struct = _rowToStruct(active);
  const data = _spmIface.encodeFunctionData('spend', [struct, BigInt(amountUsdcSmallest)]);

  const { _sendOwnerTx } = require('../base/transactionService');
  const txHash = await _sendOwnerTx(SPEND_PERMISSION_MANAGER_ADDRESS, data);
  console.log(`[SpendPermission] Spent ${amountUsdcSmallest} units for user ${userId} (tx ${txHash}, permission_hash=${active.permission_hash})`);
  return { txHash, permissionId: active.id };
}

/**
 * Revoke an active permission. Always calls revokeAsSpender from our
 * spender Smart Account — that's the on-chain function that lets the
 * spender (us) drop their own grant without needing the user's
 * signature. User-initiated revoke is a separate code path that
 * happens client-side from the wallet web surface (user signs revoke
 * via their passkey); when that lands on-chain we observe it via the
 * SPM event and call setRevoked() then.
 */
async function revokePermission(rowId) {
  const row = spendPermissionRepo.findById(rowId);
  if (!row) throw new Error(`spend_permission ${rowId} not found`);
  if (row.status === 'revoked') return row;

  const struct = _rowToStruct(row);
  const data = _spmIface.encodeFunctionData('revokeAsSpender', [struct]);

  const { _sendOwnerTx } = require('../base/transactionService');
  const txHash = await _sendOwnerTx(SPEND_PERMISSION_MANAGER_ADDRESS, data);

  spendPermissionRepo.setRevoked(rowId, txHash);
  console.log(`[SpendPermission] Row ${rowId} revoked as spender (tx ${txHash})`);
  return spendPermissionRepo.findById(rowId);
}

module.exports = {
  SPEND_PERMISSION_MANAGER_ADDRESS,
  USDC_BASE_MAINNET,
  SPEND_PERMISSION_TYPES,
  computePermissionHash,
  recordUserGrant,
  approveOnChain,
  spendForUser,
  buildSpendCalls,
  revokePermission,
  _flipWalletToSelfCustody, // exported so escrowManager can call it
                            // when the match-deposit path lands the
                            // batched approveWithSignature + spend
                            // and needs to reconcile the wallet row
};
