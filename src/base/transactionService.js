// Base transaction service — CDP Smart Account signing.
//
// All transactions are signed via the CDP SDK and submitted as
// UserOperations through the CDP Bundler. The Coinbase Paymaster
// automatically sponsors gas for USDC transfers on Base, so every
// operation is gasless for the user.
//
// The caller passes in a sender address (Base address string) and
// this module handles ABI encoding + transaction submission via the
// new @coinbase/cdp-sdk.

const { ethers } = require('ethers');
const { getCdpClient, USDC_CONTRACT, ERC20_ABI } = require('./walletManager');
const { getNetwork } = require('./connection');

/**
 * Resolve the CDP network string ('base' or 'base-sepolia').
 */
function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

/**
 * Transfer USDC from a CDP Smart Account to a destination address.
 * Gas is sponsored by the Coinbase Paymaster — completely gasless.
 *
 * @param {string} fromAddress - The sender's Base address
 * @param {string} toAddress - Destination Base/Ethereum address
 * @param {string} amountSmallest - Amount in USDC smallest units (6 decimals)
 * @returns {Promise<{ hash: string, signature: string }>}
 */
async function transferUsdc(fromAddress, toAddress, amountSmallest) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  // ABI-encode the ERC-20 transfer(address,uint256) call
  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData('transfer', [toAddress, amountSmallest]);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: USDC_CONTRACT,
      value: '0x0',
      data,
    },
  });

  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Transfer ETH from a CDP Smart Account. Used for admin operations
 * only — regular users never send ETH (Paymaster covers gas).
 *
 * @param {string} fromAddress - The sender's Base address
 * @param {string} toAddress - Destination address
 * @param {string} amountWei - Amount in wei
 * @returns {Promise<{ hash: string, signature: string }>}
 */
async function transferEth(fromAddress, toAddress, amountWei) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  // Convert wei string to hex value for the transaction
  const valueHex = '0x' + BigInt(amountWei).toString(16);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: toAddress,
      value: valueHex,
    },
  });

  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Invoke a smart contract function from a CDP Smart Account.
 * Used for escrow contract calls (createMatch, depositToEscrow,
 * resolveMatch, cancelMatch).
 *
 * @param {string} fromAddress - The sender's Base address
 * @param {string} contractAddress - Target contract address
 * @param {string} method - e.g. 'depositToEscrow'
 * @param {object} args - Method arguments as { paramName: value }
 * @param {Array} abi - ABI array (parsed, not stringified)
 * @returns {Promise<{ hash: string }>}
 */
async function invokeContract(fromAddress, contractAddress, method, args, abi) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  // Extract argument values in ABI-defined order so encodeFunctionData
  // receives them in the correct positional sequence.
  const abiEntry = abi.find(f => f.name === method);
  if (!abiEntry) {
    throw new Error(`Method '${method}' not found in provided ABI`);
  }
  const orderedArgs = abiEntry.inputs.map(i => args[i.name]);

  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(method, orderedArgs);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: contractAddress,
      data,
    },
  });

  console.log(`[Base] Contract call ${method} on ${contractAddress} confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

/**
 * Call approve() on the USDC contract from a user's Smart Account,
 * granting the escrow contract unlimited allowance. Gasless via
 * Paymaster.
 *
 * @param {string} fromAddress - The user's Base address
 * @param {string} spenderAddress - The address to approve (escrow contract)
 * @returns {Promise<{ hash: string, signature: string }>}
 */
async function approveUsdc(fromAddress, spenderAddress) {
  const cdp = getCdpClient();
  const cdpNetwork = getCdpNetwork();

  const approveAbi = [
    {
      name: 'approve',
      type: 'function',
      inputs: [
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
      ],
      outputs: [{ name: '', type: 'bool' }],
    },
  ];

  const iface = new ethers.Interface(approveAbi);
  const data = iface.encodeFunctionData('approve', [
    spenderAddress,
    ethers.MaxUint256.toString(),
  ]);

  const { transactionHash } = await cdp.evm.sendTransaction({
    address: fromAddress,
    network: cdpNetwork,
    transaction: {
      to: USDC_CONTRACT,
      data,
    },
  });

  console.log(`[Base] USDC approve(${spenderAddress}, MAX) confirmed: ${transactionHash}`);
  return { hash: transactionHash, signature: transactionHash };
}

// Backward-compat aliases
const transferSol = transferEth;

// No more getHotWalletSigner — Paymaster covers gas, no gas funder needed.
// If legacy code calls this, it'll throw with a clear message.
function getHotWalletSigner() {
  throw new Error(
    'getHotWalletSigner() is deprecated. Smart Accounts use the Coinbase Paymaster for gas. ' +
    'No gas funder wallet is needed. Use cdp.evm.sendTransaction() instead.'
  );
}

module.exports = {
  transferUsdc,
  transferEth,
  transferSol,
  invokeContract,
  approveUsdc,
  getHotWalletSigner,
};
