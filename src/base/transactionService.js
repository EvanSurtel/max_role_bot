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
 */
async function _sendUserOp(smartAccount, calls) {
  const cdp = getCdpClient();
  const network = getCdpNetwork();

  const result = await cdp.evm.prepareAndSendUserOperation({
    smartAccount,
    network,
    calls: calls.map(c => ({
      to: c.to,
      value: c.value ?? 0n,
      data: c.data || '0x',
    })),
  });

  const receipt = await cdp.evm.waitForUserOperation({
    smartAccountAddress: smartAccount.address,
    userOpHash: result.userOpHash,
  });

  if (receipt.status === 'complete' && receipt.transactionHash) {
    return receipt.transactionHash;
  }
  return result.userOpHash;
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
