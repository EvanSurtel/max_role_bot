// Base transaction service — CDP Smart Accounts + Paymaster.
//
// ALL transactions use Smart Account UserOps (gasless via Paymaster):
//   - User USDC approve / transfer → user's Smart Account
//   - Escrow admin calls (createMatch / resolveMatch / cancelMatch /
//     depositToEscrow) → `escrow-owner-smart` Smart Account
//
// The `escrow-owner` EOA is DORMANT after deploy. It signed the
// one-time deploy + transferOwnership tx, then never again. No ETH
// balance required at runtime anywhere.

const { ethers } = require('ethers');
const { getCdpClient, getSmartAccountFromRef, USDC_CONTRACT } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

// Cached escrow-owner Smart Account so we don't re-fetch per call.
let _escrowOwnerSmart = null;

async function _getEscrowOwnerSmartAccount() {
  if (_escrowOwnerSmart) return _escrowOwnerSmart;
  const { smartAccount } = await getSmartAccountFromRef('escrow-owner', 'escrow-owner-smart');
  if (!smartAccount) throw new Error('Could not load escrow-owner-smart — run scripts/create-owner-wallet.js first.');
  _escrowOwnerSmart = smartAccount;
  return smartAccount;
}

/**
 * Send a gasless UserOp via Smart Account + Paymaster.
 * Uses prepareAndSendUserOperation (1-step server-side) as primary.
 *
 * Errors thrown from this function are tagged with `.stage`:
 *   'pre_submit'  — the UserOp was never submitted on-chain. Safe to
 *                   credit back / retry; there is no outstanding tx.
 *   'post_submit' — the UserOp was submitted (we have a userOpHash)
 *                   but confirmation was not observed within the CDP
 *                   wait window. The on-chain outcome is UNKNOWN —
 *                   it may still land minutes later. Callers MUST
 *                   NOT credit the user back on this error class;
 *                   route the row to pending_verification and let
 *                   pendingWithdrawSweeper resolve it by polling
 *                   cdp.evm.getUserOperation.
 * On 'post_submit' errors, `.userOpHash` and `.smartAccountAddress`
 * are attached so the caller can persist them.
 */
async function _sendUserOp(smartAccount, calls) {
  const cdp = getCdpClient();
  const network = getCdpNetwork();

  // The paymaster URL is what makes user ops gasless. Without it, the
  // bundler asks the sender Smart Account to pay for gas — and user
  // SAs (and escrow-owner-smart) never hold ETH by design. Error
  // looks like "sender balance and deposit together is 0 but must
  // be at least ... to pay for this operation" when this is omitted.
  //
  // PAYMASTER_RPC_URL format (from CDP dashboard, per project):
  //   https://api.developer.coinbase.com/rpc/v1/<network>/<paymaster_key>
  // Fail loudly at the first UserOp if it's missing, rather than
  // silently draining the sender on a random future approve.
  const paymasterUrl = process.env.PAYMASTER_RPC_URL;
  if (!paymasterUrl) {
    const err = new Error('PAYMASTER_RPC_URL not set — every UserOp would require ETH in the sender Smart Account. Configure the CDP Paymaster URL in your env.');
    err.stage = 'pre_submit';
    throw err;
  }

  let result;
  try {
    result = await cdp.evm.prepareAndSendUserOperation({
      smartAccount,
      network,
      paymasterUrl,
      calls: calls.map(c => ({
        to: c.to,
        value: c.value ?? 0n,
        data: c.data || '0x',
      })),
    });
  } catch (err) {
    err.stage = 'pre_submit';
    throw err;
  }

  try {
    const receipt = await cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: result.userOpHash,
    });

    if (receipt.status === 'complete' && receipt.transactionHash) {
      return receipt.transactionHash;
    }
    // waitForUserOperation returned a non-complete receipt (unusual
    // but possible). Treat as post-submit uncertainty.
    const err = new Error(`UserOp ${result.userOpHash} not complete (status=${receipt.status})`);
    err.stage = 'post_submit';
    err.userOpHash = result.userOpHash;
    err.smartAccountAddress = smartAccount.address;
    throw err;
  } catch (err) {
    if (err.stage === 'post_submit') throw err;
    // wait threw (timeout, RPC blip, etc.) — UserOp was submitted;
    // don't know if it landed.
    err.stage = 'post_submit';
    err.userOpHash = result.userOpHash;
    err.smartAccountAddress = smartAccount.address;
    throw err;
  }
}

/**
 * Send an escrow admin call via the owner Smart Account's UserOp
 * flow — Paymaster-sponsored, no ETH required.
 *
 * Signature mirrors the old _sendOwnerTx(to, data, value) for drop-in
 * replacement at call sites.
 */
async function _sendOwnerTx(to, data, value = 0n) {
  const smartAccount = await _getEscrowOwnerSmartAccount();
  return await _sendUserOp(smartAccount, [{
    to,
    value: BigInt(value || 0n),
    data: data || '0x',
  }]);
}

/**
 * Get the Smart Account for a user from their stored refs.
 */
async function _getUserSmartAccount(refs) {
  if (!refs?.ownerRef || !refs?.smartRef) {
    throw new Error('Smart Account refs required (ownerRef + smartRef)');
  }
  const { smartAccount } = await getSmartAccountFromRef(refs.ownerRef, refs.smartRef);
  if (!smartAccount) throw new Error('Smart Account not found');
  return smartAccount;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Transfer USDC from a user's Smart Account (gasless).
 */
async function transferUsdc(fromAddress, toAddress, amountSmallest, refs) {
  const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const data = iface.encodeFunctionData('transfer', [toAddress, BigInt(amountSmallest)]);
  const sa = await _getUserSmartAccount(refs);
  const hash = await _sendUserOp(sa, [{ to: USDC_CONTRACT, value: 0n, data }]);
  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} (gasless): ${hash}`);
  return { hash, signature: hash };
}

/**
 * Transfer ETH — via the escrow-owner Smart Account (Paymaster-sponsored).
 * Kept for legacy admin panel ETH moves; in practice no ETH should
 * ever live in the owner account anymore.
 */
async function transferEth(fromAddress, toAddress, amountWei) {
  const hash = await _sendOwnerTx(toAddress, '0x', BigInt(amountWei));
  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Invoke an escrow contract function as the on-chain owner.
 * Routed through the escrow-owner Smart Account's UserOp flow → gas
 * sponsored by the CDP Paymaster. No ETH balance required anywhere.
 */
async function invokeContract(fromAddress, contractAddress, method, args, abi) {
  const abiEntry = abi.find(f => f.name === method);
  if (!abiEntry) throw new Error(`Method '${method}' not found in ABI`);
  const orderedArgs = abiEntry.inputs.map(i => args[i.name]);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(method, orderedArgs);
  const hash = await _sendOwnerTx(contractAddress, data);
  console.log(`[Base] Contract call ${method} on ${contractAddress}: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Approve escrow to spend USDC from a user's Smart Account (gasless).
 */
async function approveUsdc(fromAddress, spenderAddress, refs) {
  const iface = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [spenderAddress, ethers.MaxUint256]);
  const sa = await _getUserSmartAccount(refs);
  const hash = await _sendUserOp(sa, [{ to: USDC_CONTRACT, value: 0n, data }]);
  console.log(`[Base] USDC approve(${spenderAddress}, MAX) gasless: ${hash}`);
  return { hash, signature: hash };
}

const transferSol = transferEth;

module.exports = {
  transferUsdc,
  transferEth,
  transferSol,
  invokeContract,
  approveUsdc,
};
