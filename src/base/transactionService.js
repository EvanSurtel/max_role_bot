// Base transaction service — CDP Smart Account signing.
//
// All transactions are signed via the CDP SDK and submitted as
// UserOperations through the CDP Bundler. The Coinbase Paymaster
// automatically sponsors gas for USDC transfers on Base, so every
// operation is gasless for the user.
//
// The caller passes in a CDP Wallet object (from walletManager
// .getWalletFromEncrypted) and this module handles the transfer.

const { ethers } = require('ethers');
const { getProvider } = require('./connection');
const { USDC_CONTRACT, ERC20_ABI } = require('./walletManager');

/**
 * Transfer USDC from a CDP Smart Account to a destination address.
 * Gas is sponsored by the Coinbase Paymaster — completely gasless.
 *
 * @param {import('@coinbase/coinbase-sdk').Wallet} cdpWallet - The user's CDP wallet
 * @param {string} toAddress - Destination Base/Ethereum address
 * @param {string} amountSmallest - Amount in USDC smallest units (6 decimals)
 * @returns {Promise<{ hash: string, signature: string }>}
 */
async function transferUsdc(cdpWallet, toAddress, amountSmallest) {
  // Convert smallest units to human-readable for the CDP SDK
  const amountUsdc = Number(amountSmallest) / 1_000_000;

  // CDP SDK transfer — handles UserOp bundling + Paymaster automatically
  const transfer = await cdpWallet.createTransfer({
    amount: amountUsdc,
    assetId: 'usdc',
    destination: toAddress,
    gasless: true,  // Paymaster sponsors gas
  });

  // Wait for the transfer to land on-chain
  await transfer.wait();

  const hash = transfer.getTransactionHash();
  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} confirmed: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Transfer ETH from a CDP Smart Account. Used for admin operations
 * only — regular users never send ETH (Paymaster covers gas).
 *
 * @param {import('@coinbase/coinbase-sdk').Wallet} cdpWallet
 * @param {string} toAddress
 * @param {string} amountWei - Amount in wei
 * @returns {Promise<{ hash: string, signature: string }>}
 */
async function transferEth(cdpWallet, toAddress, amountWei) {
  const amountEth = Number(amountWei) / 1e18;

  const transfer = await cdpWallet.createTransfer({
    amount: amountEth,
    assetId: 'eth',
    destination: toAddress,
  });

  await transfer.wait();

  const hash = transfer.getTransactionHash();
  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress} confirmed: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Invoke a smart contract function from a CDP Smart Account.
 * Used for escrow contract calls (createMatch, depositToEscrow,
 * resolveMatch, cancelMatch).
 *
 * @param {import('@coinbase/coinbase-sdk').Wallet} cdpWallet
 * @param {string} contractAddress
 * @param {string} method - e.g. 'depositToEscrow'
 * @param {object} args - method arguments
 * @param {string} abi - JSON ABI string or array
 * @returns {Promise<{ hash: string }>}
 */
async function invokeContract(cdpWallet, contractAddress, method, args, abi) {
  const invocation = await cdpWallet.invokeContract({
    contractAddress,
    method,
    args,
    abi,
  });

  await invocation.wait();

  const hash = invocation.getTransactionHash();
  console.log(`[Base] Contract call ${method} on ${contractAddress} confirmed: ${hash}`);
  return { hash, signature: hash };
}

/**
 * Call approve() on the USDC contract from a user's Smart Account,
 * granting the escrow contract unlimited allowance. Gasless via
 * Paymaster.
 */
async function approveUsdc(cdpWallet, spenderAddress) {
  const invocation = await cdpWallet.invokeContract({
    contractAddress: USDC_CONTRACT,
    method: 'approve',
    args: {
      spender: spenderAddress,
      value: ethers.MaxUint256.toString(),
    },
    abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
  });

  await invocation.wait();

  const hash = invocation.getTransactionHash();
  console.log(`[Base] USDC approve(${spenderAddress}, MAX) confirmed: ${hash}`);
  return { hash, signature: hash };
}

// Backward-compat aliases
const transferSol = transferEth;

// No more getHotWalletSigner — Paymaster covers gas, no gas funder needed.
// If legacy code calls this, it'll throw with a clear message.
function getHotWalletSigner() {
  throw new Error(
    'getHotWalletSigner() is deprecated. Smart Accounts use the Coinbase Paymaster for gas. ' +
    'No gas funder wallet is needed. Use CDP Wallet.createTransfer() instead.'
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
