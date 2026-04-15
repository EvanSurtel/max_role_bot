// Base transaction service — CDP Smart Accounts + Paymaster.
//
// ALL user transactions use Smart Account UserOps (gasless).
// Owner/admin escrow calls use EOA sendTransaction (owner has ETH).
// No EOA fallback for users — Paymaster handles all gas.

const { ethers } = require('ethers');
const { getCdpClient, getSmartAccountFromRef, USDC_CONTRACT } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
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
 * Send a transaction from the owner EOA (for escrow contract calls only).
 * Owner account has ETH for gas — this is NOT used for user transactions.
 */
async function _sendOwnerTx(to, data, value = 0n) {
  const cdp = getCdpClient();
  const network = getCdpNetwork();
  const ownerAddr = process.env.CDP_OWNER_ADDRESS;
  if (!ownerAddr) throw new Error('CDP_OWNER_ADDRESS not set');

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { transactionHash } = await cdp.evm.sendTransaction({
        address: ownerAddr,
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
 * Transfer ETH — owner only (for admin operations).
 */
async function transferEth(fromAddress, toAddress, amountWei) {
  const hash = await _sendOwnerTx(toAddress, '0x', BigInt(amountWei));
  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Invoke escrow contract function (owner EOA — needs ETH).
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
