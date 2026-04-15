// Base transaction service — CDP Smart Accounts + EOA fallback.
//
// Primary path: Smart Account UserOps via sendUserOperation (gasless).
//   - Base Sepolia: gas subsidized by default (no paymasterUrl needed)
//   - Base mainnet: gas sponsored via CDP Paymaster (auto-configured)
//
// Fallback path: EOA sendTransaction (needs ETH for gas).
//   - Used when the wallet is a legacy EOA-only account
//   - Used when the Smart Account UserOp fails
//
// The SDK provides two UserOp methods:
//   1. cdp.evm.sendUserOperation() — 3-step: prepare -> sign -> send
//   2. cdp.evm.prepareAndSendUserOperation() — 1-step: server handles all
//
// We use #1 (sendUserOperation) as primary since it works with both
// CDP server accounts and external signers. If it fails, we try
// #2 (prepareAndSendUserOperation) which only works with CDP server
// account owners but handles signing entirely server-side.

const { ethers } = require('ethers');
const { getCdpClient, getSmartAccountFromRef, USDC_CONTRACT } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

// ─── Smart Account UserOp (gasless) ─────────────────────────

/**
 * Send a UserOp via Smart Account. Tries sendUserOperation first,
 * falls back to prepareAndSendUserOperation if the signature fails.
 *
 * @param {object} smartAccount — CDP Smart Account object
 * @param {Array} calls — Array of { to, value, data } call objects
 * @returns {string} — Transaction hash
 */
async function _sendUserOp(smartAccount, calls) {
  const cdp = getCdpClient();
  const network = getCdpNetwork();

  // Attempt 1: sendUserOperation (3-step: prepare -> sign -> send)
  try {
    const result = await cdp.evm.sendUserOperation({
      smartAccount,
      network,
      calls,
    });

    // Wait for the UserOp to complete and get the transaction hash
    const receipt = await cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: result.userOpHash,
    });

    if (receipt.status === 'complete' && receipt.transactionHash) {
      return receipt.transactionHash;
    }

    // If completed but no hash, return the userOpHash as fallback
    return result.userOpHash;
  } catch (err) {
    const msg = err.errorMessage || err.message || '';
    console.warn(`[Base] sendUserOperation failed: ${msg}`);

    // If it's a signature error, try the server-side 1-step method
    if (msg.includes('signature') || msg.includes('UserOp')) {
      console.log('[Base] Retrying with prepareAndSendUserOperation (server-side)...');
      try {
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
      } catch (err2) {
        console.error(`[Base] prepareAndSendUserOperation also failed: ${err2.errorMessage || err2.message}`);
        throw err2;
      }
    }

    throw err;
  }
}

// ─── EOA sendTransaction (fallback) ─────────────────────────

/**
 * Send a transaction via EOA with nonce retry (handles rapid sequential txs).
 */
async function _sendTx(address, to, data, value = 0n) {
  const cdp = getCdpClient();
  const network = getCdpNetwork();

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { transactionHash } = await cdp.evm.sendTransaction({
        address,
        network,
        transaction: { to, value, data: data || '0x' },
      });
      return transactionHash;
    } catch (err) {
      lastErr = err;
      const msg = err.errorMessage || err.message || '';
      if (msg.includes('Nonce too low') || msg.includes('nonce')) {
        console.warn(`[Base] Nonce issue, retrying (${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─── Hybrid send: Smart Account first, EOA fallback ────────

/**
 * Send a call trying Smart Account UserOp first, falling back to EOA.
 *
 * @param {string} address — The wallet address (Smart Account or EOA)
 * @param {string} ownerAccountName — The owner EOA name (from account_ref)
 * @param {string} [smartAccountName] — The Smart Account name (from smart_account_ref)
 * @param {string} to — Target contract address
 * @param {string} data — Encoded calldata
 * @param {bigint} [value=0n] — ETH value in wei
 * @returns {string} — Transaction hash
 */
async function _sendHybrid(address, ownerAccountName, smartAccountName, to, data, value = 0n) {
  // Try Smart Account path first (gasless)
  if (smartAccountName && ownerAccountName) {
    try {
      const { smartAccount } = await getSmartAccountFromRef(ownerAccountName, smartAccountName);
      if (smartAccount) {
        const hash = await _sendUserOp(smartAccount, [{ to, value, data: data || '0x' }]);
        return hash;
      }
    } catch (err) {
      console.warn(`[Base] Smart Account UserOp failed, falling back to EOA: ${err.message}`);
    }
  }

  // Fallback: EOA sendTransaction (needs ETH for gas)
  // Use the owner account name to resolve the EOA address
  if (ownerAccountName) {
    try {
      const { owner } = await getSmartAccountFromRef(ownerAccountName);
      return await _sendTx(owner.address, to, data, value);
    } catch (err) {
      console.warn(`[Base] EOA via owner name failed: ${err.message}`);
    }
  }

  // Last resort: try sendTransaction with the address directly
  // (works for legacy EOA-only wallets where address === EOA address)
  return await _sendTx(address, to, data, value);
}

// ─── Public API ─────────────────────────────────────────────

async function transferUsdc(fromAddress, toAddress, amountSmallest, { ownerRef, smartRef } = {}) {
  const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const data = iface.encodeFunctionData('transfer', [toAddress, BigInt(amountSmallest)]);
  const hash = await _sendHybrid(fromAddress, ownerRef, smartRef, USDC_CONTRACT, data);
  console.log(`[Base] USDC transfer ${amountSmallest} -> ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function transferEth(fromAddress, toAddress, amountWei, { ownerRef, smartRef } = {}) {
  const hash = await _sendHybrid(fromAddress, ownerRef, smartRef, toAddress, '0x', BigInt(amountWei));
  console.log(`[Base] ETH transfer ${amountWei} wei -> ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function invokeContract(fromAddress, contractAddress, method, args, abi, { ownerRef, smartRef } = {}) {
  const abiEntry = abi.find(f => f.name === method);
  if (!abiEntry) throw new Error(`Method '${method}' not found in ABI`);
  const orderedArgs = abiEntry.inputs.map(i => args[i.name]);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(method, orderedArgs);
  const hash = await _sendHybrid(fromAddress, ownerRef, smartRef, contractAddress, data);
  console.log(`[Base] Contract call ${method} on ${contractAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function approveUsdc(fromAddress, spenderAddress, { ownerRef, smartRef } = {}) {
  const iface = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [spenderAddress, ethers.MaxUint256]);
  const hash = await _sendHybrid(fromAddress, ownerRef, smartRef, USDC_CONTRACT, data);
  console.log(`[Base] USDC approve(${spenderAddress}, MAX): ${hash}`);
  return { hash, signature: hash };
}

const transferSol = transferEth;

module.exports = {
  transferUsdc,
  transferEth,
  transferSol,
  invokeContract,
  approveUsdc,
  // Expose for direct use by escrowManager etc.
  _sendUserOp,
  _sendTx,
};
