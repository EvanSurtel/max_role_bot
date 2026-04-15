// Base transaction service — CDP EOA accounts via sendTransaction.
//
// CDP Smart Accounts (sendUserOperation) have a known signature bug.
// All transactions use cdp.evm.sendTransaction with EOA accounts.
// Gas on Base is ~$0.01/tx — auto-funded via faucet on testnet.

const { ethers } = require('ethers');
const { getCdpClient, USDC_CONTRACT } = require('./walletManager');
const { getNetwork } = require('./connection');

function getCdpNetwork() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

/**
 * Send a transaction with nonce retry (handles rapid sequential txs).
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

async function transferUsdc(fromAddress, toAddress, amountSmallest) {
  const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const data = iface.encodeFunctionData('transfer', [toAddress, BigInt(amountSmallest)]);
  const hash = await _sendTx(fromAddress, USDC_CONTRACT, data);
  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function transferEth(fromAddress, toAddress, amountWei) {
  const hash = await _sendTx(fromAddress, toAddress, '0x', BigInt(amountWei));
  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function invokeContract(fromAddress, contractAddress, method, args, abi) {
  const abiEntry = abi.find(f => f.name === method);
  if (!abiEntry) throw new Error(`Method '${method}' not found in ABI`);
  const orderedArgs = abiEntry.inputs.map(i => args[i.name]);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData(method, orderedArgs);
  const hash = await _sendTx(fromAddress, contractAddress, data);
  console.log(`[Base] Contract call ${method} on ${contractAddress}: ${hash}`);
  return { hash, signature: hash };
}

async function approveUsdc(fromAddress, spenderAddress) {
  const iface = new ethers.Interface(['function approve(address spender, uint256 value) returns (bool)']);
  const data = iface.encodeFunctionData('approve', [spenderAddress, ethers.MaxUint256]);
  const hash = await _sendTx(fromAddress, USDC_CONTRACT, data);
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
};
