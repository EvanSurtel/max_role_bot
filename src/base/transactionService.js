// Base transaction service — CDP Smart Account signing.
//
// All transactions go through the CDP SDK. For USDC transfers, we use
// the account.transfer() helper which handles ERC-20 encoding internally.
// For contract calls, we ABI-encode and use sendTransaction.

const { ethers } = require('ethers');
const { getCdpClient, USDC_CONTRACT, ERC20_ABI } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

/**
 * Transfer USDC using the CDP account.transfer() helper.
 * Handles ERC-20 encoding internally — no manual ABI encoding needed.
 */
async function transferUsdc(fromAddress, toAddress, amountSmallest) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  // Get the account object so we can use .transfer()
  const account = await cdp.evm.getAccount({ address: fromAddress });

  const { transactionHash } = await account.transfer({
    to: toAddress,
    amount: BigInt(amountSmallest),
    token: 'usdc',
    network: cdpNetwork,
  });

  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Transfer ETH from a CDP account.
 */
async function transferEth(fromAddress, toAddress, amountWei) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: toAddress,
      value: BigInt(amountWei),
    },
  });

  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Invoke a smart contract function via ABI-encoded sendTransaction.
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
    transaction: {
      to: contractAddress,
      value: 0n,
      data,
    },
  });

  console.log(`[Base] Contract call ${method} on ${contractAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Approve the escrow contract to spend USDC from a user's account.
 */
async function approveUsdc(fromAddress, spenderAddress) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const iface = new ethers.Interface([
    'function approve(address spender, uint256 value) returns (bool)',
  ]);
  const data = iface.encodeFunctionData('approve', [
    spenderAddress,
    ethers.MaxUint256,
  ]);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: USDC_CONTRACT,
      value: 0n,
      data,
    },
  });

  console.log(`[Base] USDC approve(${spenderAddress}, MAX) confirmed: ${transactionHash}`);
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
