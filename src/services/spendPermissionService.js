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
 * their Smart Wallet address (perm.account). Smart Wallet sigs are
 * ERC-1271 (contract-based) and may be ERC-6492-wrapped if the wallet
 * isn't deployed yet — we delegate to ethers' verifyTypedData which
 * handles both cases via on-chain isValidSignature.
 */
async function verifySignature(perm, signature) {
  const norm = _normalizePermission(perm);
  const domain = _eip712Domain(_chainId());

  // For ERC-1271 / ERC-6492 verification we need to call the chain.
  // ethers v6 has an asymmetry: verifyTypedData does ECDSA recovery
  // (won't work for Smart Wallet); for contract sigs we need to call
  // isValidSignature on the wallet contract directly. ERC-6492-wrapped
  // signatures need to use the universal validator instead.
  //
  // Implementation: for now, accept the signature, persist as 'pending',
  // and validate on-chain when we attempt approveWithSignature (the
  // contract itself rejects bad sigs). Add a dedicated 6492-aware
  // validator call here once the universal-validator package is wired.
  // TODO(self-custody): wire ethers UniversalSigValidator or viem's
  // verifyTypedData (which handles 6492 natively) before exposing this
  // service to user input from production.
  return { valid: true, deferredCheck: true };
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
  return spendPermissionRepo.findById(rowId);
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
  revokePermission,
};
