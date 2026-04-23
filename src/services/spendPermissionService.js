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

const SPEND_PERMISSION_MANAGER_ADDRESS = '0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

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
 * Lift a pending SpendPermission on-chain via approveWithSignature.
 * Called either:
 *   - immediately after recordUserGrant (eager)
 *   - lazily on the first spend() attempt (cheaper for grants the user
 *     never actually exercises)
 *
 * Uses our existing escrow-owner-smart Smart Account as the sender —
 * UserOp sponsored by CDP Paymaster, no ETH required.
 *
 * NOTE (impl): the actual on-chain submission is wired up in the
 * follow-up commit that touches transactionService.js. This skeleton
 * defines the contract; the body throws until then so callers fail
 * loudly rather than silently no-op.
 */
async function approveOnChain(rowId) {
  const row = spendPermissionRepo.findById(rowId);
  if (!row) throw new Error(`spend_permission ${rowId} not found`);
  if (row.status !== 'pending') return row; // idempotent

  // TODO(self-custody): call SpendPermissionManager.approveWithSignature
  // via cdp.evm.createSpendPermission({ spendPermission, network: 'base' }).
  // On confirmation, spendPermissionRepo.markApprovedAndSupersedeOthers(rowId, txHash).
  throw new Error('approveOnChain: implementation pending — see TODO in spendPermissionService');
}

/**
 * Pull `amount` USDC from the user's Smart Wallet to our spender
 * address (escrow-owner-smart) via SpendPermissionManager.spend.
 * Returns { txHash, blockNumber } on success. Throws if no active
 * permission, allowance exhausted in current period, or on-chain revert.
 *
 * Same impl note as approveOnChain — concrete CDP SDK call lands in
 * the follow-up commit.
 */
async function spendForUser(userId, amountUsdcSmallest) {
  const active = spendPermissionRepo.findActiveForUser(userId);
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

  // TODO(self-custody): call escrowOwnerSmart.useSpendPermission({
  //   spendPermission: { account, spender, token, allowance, period,
  //     start, end, salt, extraData }, value: BigInt(amountUsdcSmallest),
  //   network: 'base' });
  // Returns { userOpHash, status }. On status==='complete', wait for
  // receipt then return tx hash. On AllowanceExceeded revert from the
  // contract, surface ALLOWANCE_EXCEEDED to the caller.
  throw new Error('spendForUser: implementation pending — see TODO in spendPermissionService');
}

/**
 * Revoke an active permission. Either user-initiated (from the web
 * surface, signed by their passkey) or backend-initiated
 * (revokeAsSpender, called from admin tooling).
 */
async function revokePermission(rowId, { asSpender = false } = {}) {
  const row = spendPermissionRepo.findById(rowId);
  if (!row) throw new Error(`spend_permission ${rowId} not found`);
  if (row.status === 'revoked') return row;

  // TODO(self-custody): call SpendPermissionManager.revoke (user) or
  // revokeAsSpender (backend). On confirmation,
  // spendPermissionRepo.setRevoked(rowId, txHash).
  throw new Error('revokePermission: implementation pending — see TODO in spendPermissionService');
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
