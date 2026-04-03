const xrpl = require('xrpl');
const { getClient } = require('./client');

/**
 * Send an XRP payment from one wallet to another.
 * @param {xrpl.Wallet} fromWallet - The sender's wallet instance.
 * @param {string} toAddress - The destination XRP address.
 * @param {string|number} amountDrops - Amount in drops (as string or number).
 * @param {string} [memo] - Optional memo text to attach to the transaction.
 * @returns {Promise<{ txHash: string, result: object }>}
 */
async function sendPayment(fromWallet, toAddress, amountDrops, memo) {
  const client = getClient();

  const payment = {
    TransactionType: 'Payment',
    Account: fromWallet.address,
    Amount: amountDrops.toString(),
    Destination: toAddress,
  };

  // Add memo if provided
  if (memo) {
    payment.Memos = [
      {
        Memo: {
          MemoType: Buffer.from('text/plain', 'utf8').toString('hex').toUpperCase(),
          MemoData: Buffer.from(memo, 'utf8').toString('hex').toUpperCase(),
        },
      },
    ];
  }

  const prepared = await client.autofill(payment);
  const signed = fromWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  return {
    txHash: signed.hash,
    result: result.result,
  };
}

/**
 * Look up a transaction by its hash.
 * @param {string} txHash - The transaction hash.
 * @returns {Promise<object>} The transaction details.
 */
async function getTransaction(txHash) {
  const client = getClient();

  const response = await client.request({
    command: 'tx',
    transaction: txHash,
  });

  return response.result;
}

/**
 * Get recent transactions for an account.
 * Useful for deposit detection.
 * @param {string} address - The XRP address.
 * @param {number} [limit=20] - Maximum number of transactions to return.
 * @returns {Promise<object[]>} Array of transaction objects.
 */
async function getAccountTransactions(address, limit = 20) {
  const client = getClient();

  const response = await client.request({
    command: 'account_tx',
    account: address,
    limit,
    ledger_index_min: -1,
    ledger_index_max: -1,
  });

  return response.result.transactions;
}

module.exports = {
  sendPayment,
  getTransaction,
  getAccountTransactions,
};
