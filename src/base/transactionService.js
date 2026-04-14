// Base transaction service — CDP Smart Account UserOperations.
//
// All user transactions go through sendUserOperation which is
// gasless on Base Sepolia by default and uses the Coinbase Paymaster
// on mainnet. Users never need ETH.
//
// Owner/admin transactions use regular sendTransaction (the owner
// account has ETH from the faucet for contract calls).

const { ethers } = require('ethers');
const { getCdpClient, USDC_CONTRACT, ERC20_ABI } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

/**
 * Get the Smart Account object for a user address.
 * Needs the owner EOA account to reconstruct the Smart Account.
 */
async function _getSmartAccount(cdp, ownerName) {
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });
  const smartAccount = await cdp.evm.createSmartAccount({ owner });
  return smartAccount;
}

/**
 * Transfer USDC from a user's Smart Account — gasless via Paymaster.
 */
async function transferUsdc(fromAddress, toAddress, amountSmallest, ownerAccountName) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const data = iface.encodeFunctionData('transfer', [toAddress, BigInt(amountSmallest)]);

  // If we have the owner account name, use Smart Account (gasless)
  if (ownerAccountName) {
    const smartAccount = await _getSmartAccount(cdp, ownerAccountName);
    const result = await cdp.evm.sendUserOperation({
      smartAccount,
      network: cdpNetwork,
      calls: [{ to: USDC_CONTRACT, value: 0n, data }],
    });
    console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} (gasless): ${result.userOperationHash}`);
    return { hash: result.userOperationHash, signature: result.userOperationHash };
  }

  // Fallback: regular sendTransaction (for owner/admin — needs ETH)
  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: { to: USDC_CONTRACT, value: 0n, data },
  });
  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress}: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Transfer ETH — admin only (users never send ETH).
 */
async function transferEth(fromAddress, toAddress, amountWei) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: { to: toAddress, value: BigInt(amountWei) },
  });

  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress}: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Invoke a smart contract — uses regular sendTransaction (owner account).
 */
async function invokeContract(fromAddress, contractAddress, method, args, abi) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const abiEntry = abi.find(f => f.name === method);
  if (!abiEntry) throw new Error(`Method '${method}' not found in ABI`);
  const orderedArgs = abiEntry.inputs.map(i => args[i.name]);

  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(method, orderedArgs);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: { to: contractAddress, value: 0n, data },
  });

  console.log(`[Base] Contract call ${method} on ${contractAddress}: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Approve escrow contract to spend USDC — gasless via Smart Account.
 */
async function approveUsdc(fromAddress, spenderAddress, ownerAccountName) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const iface = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [spenderAddress, ethers.MaxUint256]);

  if (ownerAccountName) {
    const smartAccount = await _getSmartAccount(cdp, ownerAccountName);
    const result = await cdp.evm.sendUserOperation({
      smartAccount,
      network: cdpNetwork,
      calls: [{ to: USDC_CONTRACT, value: 0n, data }],
    });
    console.log(`[Base] USDC approve(${spenderAddress}, MAX) gasless: ${result.userOperationHash}`);
    return { hash: result.userOperationHash, signature: result.userOperationHash };
  }

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: { to: USDC_CONTRACT, value: 0n, data },
  });
  console.log(`[Base] USDC approve(${spenderAddress}, MAX): ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

const transferSol = transferEth;

function getHotWalletSigner() {
  throw new Error('getHotWalletSigner() is deprecated. Use CDP SDK instead.');
}

module.exports = {
  transferUsdc,
  transferEth,
  transferSol,
  invokeContract,
  approveUsdc,
  getHotWalletSigner,
};
