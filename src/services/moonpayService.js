// MoonPay business logic.
//
// This is the layer between the stateless URL-signing utility
// (moonpay.js) and the rest of the bot. It:
//
//   1. Creates moonpay_transactions rows so every initiated flow
//      is tracked by user + external_id
//   2. Handles incoming webhook events by updating that row and,
//      for off-ramps, triggering the actual USDC transfer out of
//      the user's wallet to MoonPay's deposit address when MoonPay
//      tells us it's ready
//   3. Posts progress to the admin #transactions feed so operators
//      can see MoonPay activity in real time
//
// Off-ramp is the complicated one. The happy path is:
//
//   a) User clicks "Cash Out to Bank" → initiateOfframp(user, $25)
//   b) Bot generates a signed MoonPay sell URL with externalTransactionId
//      and stores a `pending` row in moonpay_transactions
//   c) User opens the URL, fills out bank info on MoonPay's page
//   d) MoonPay creates the transaction on their side and fires a
//      webhook → we update our row with moonpay_id + fiat details
//   e) When MoonPay has a deposit address ready they fire another
//      webhook with `status: 'waitingForDeposit'` and the deposit
//      wallet. _executeOfframpTransfer picks that up, acquires the
//      wallet lock, signs a USDC transfer from the user's bot
//      wallet to MoonPay's address, debits the user's DB balance,
//      and stores the signature on the row.
//   f) MoonPay sees the USDC arrive, converts it to fiat, pays
//      out to the user's bank. A final `completed` webhook closes
//      the row.

const crypto = require('crypto');
const moonpay = require('./moonpay');
const db = require('../database/db');
const walletRepo = require('../database/repositories/walletRepo');
const userRepo = require('../database/repositories/userRepo');
const walletManager = require('../solana/walletManager');
const transactionService = require('../solana/transactionService');

const USDC_PER_UNIT = 1_000_000;

function _genExternalId() {
  return crypto.randomUUID();
}

/**
 * Initiate an on-ramp for a user.
 * Returns `{ url, externalId }` — the bot sends `url` to the user
 * as an ephemeral Discord message and the user opens it in a
 * browser.
 */
function initiateOnramp(userId) {
  if (!moonpay.isConfigured()) {
    throw new Error('MoonPay is not configured (missing API keys)');
  }
  const user = userRepo.findById(userId);
  if (!user) throw new Error('User not found');
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) throw new Error('Wallet not found');

  const externalId = _genExternalId();
  const url = moonpay.buildSignedOnRampUrl({
    walletAddress: wallet.solana_address,
    externalTransactionId: externalId,
  });

  db.prepare(`
    INSERT INTO moonpay_transactions (external_id, user_id, type, status)
    VALUES (?, ?, 'onramp', 'pending')
  `).run(externalId, userId);

  console.log(`[MoonPay] On-ramp initiated user=${userId} external_id=${externalId}`);
  return { url, externalId };
}

/**
 * Initiate an off-ramp. `quoteCurrencyAmount` is the fiat amount
 * (USD dollars) the user wants to receive — MoonPay will compute
 * the USDC amount needed from that.
 */
function initiateOfframp(userId, quoteCurrencyAmount) {
  if (!moonpay.isConfigured()) {
    throw new Error('MoonPay is not configured (missing API keys)');
  }
  const user = userRepo.findById(userId);
  if (!user) throw new Error('User not found');
  const wallet = walletRepo.findByUserId(userId);
  if (!wallet) throw new Error('Wallet not found');

  const externalId = _genExternalId();
  const url = moonpay.buildSignedOffRampUrl({
    walletAddress: wallet.solana_address,
    externalTransactionId: externalId,
    quoteCurrencyAmount,
    refundWalletAddress: wallet.solana_address,
  });

  db.prepare(`
    INSERT INTO moonpay_transactions (external_id, user_id, type, status, fiat_amount)
    VALUES (?, ?, 'offramp', 'pending', ?)
  `).run(externalId, userId, quoteCurrencyAmount != null ? String(quoteCurrencyAmount) : null);

  console.log(`[MoonPay] Off-ramp initiated user=${userId} external_id=${externalId}`);
  return { url, externalId };
}

/**
 * Handle an incoming MoonPay webhook event. The webhook server
 * has already verified the signature before calling this.
 *
 * MoonPay webhook shape (summarized from their docs):
 * {
 *   type: 'transaction_created' | 'transaction_updated' | 'transaction_failed' | ...,
 *   data: {
 *     id: '<moonpay txn id>',
 *     externalTransactionId: '<our UUID>',
 *     status: 'pending' | 'waitingForDeposit' | 'waitingForAuthorization' |
 *             'inReview' | 'processing' | 'completed' | 'failed',
 *     baseCurrencyAmount: 10.0,        // USDC amount
 *     quoteCurrencyAmount: 9.50,       // fiat amount
 *     quoteCurrencyCode: 'usd',
 *     depositWallet: { walletAddress: '…' },  // off-ramp only
 *     …
 *   }
 * }
 */
async function handleWebhook(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};
  const externalId = data.externalTransactionId;

  if (!externalId) {
    console.warn(`[MoonPay] Webhook ${type} missing externalTransactionId — ignoring`);
    return;
  }

  const row = db.prepare('SELECT * FROM moonpay_transactions WHERE external_id = ?').get(externalId);
  if (!row) {
    console.warn(`[MoonPay] Webhook ${type} references unknown external_id=${externalId}`);
    return;
  }

  const newStatus = data.status || row.status;

  // Update our record with whatever new info the webhook carries
  db.prepare(`
    UPDATE moonpay_transactions
    SET moonpay_id = COALESCE(?, moonpay_id),
        status = ?,
        amount_usdc = COALESCE(?, amount_usdc),
        fiat_amount = COALESCE(?, fiat_amount),
        fiat_currency = COALESCE(?, fiat_currency),
        deposit_address = COALESCE(?, deposit_address),
        updated_at = datetime('now')
    WHERE external_id = ?
  `).run(
    data.id || null,
    newStatus,
    data.baseCurrencyAmount != null ? String(data.baseCurrencyAmount) : null,
    data.quoteCurrencyAmount != null ? String(data.quoteCurrencyAmount) : null,
    data.quoteCurrencyCode || null,
    (data.depositWallet && data.depositWallet.walletAddress) || null,
    externalId,
  );

  console.log(`[MoonPay] Webhook ${type} external_id=${externalId} status=${newStatus}`);

  // Off-ramp: when MoonPay reports "waitingForDeposit" and gives us
  // the deposit address, kick off the on-chain USDC transfer from
  // the user's wallet to that address.
  if (row.type === 'offramp' && newStatus === 'waitingForDeposit') {
    const depositAddress = data.depositWallet && data.depositWallet.walletAddress;
    const amountUsdc = data.baseCurrencyAmount;
    if (depositAddress && amountUsdc != null) {
      await _executeOfframpTransfer(row.id, depositAddress, amountUsdc).catch(err => {
        console.error(`[MoonPay] Off-ramp transfer failed for row ${row.id}:`, err.message);
      });
    }
  }

  // Mirror major status changes to the admin transactions channel
  try {
    const { postTransaction } = require('../utils/transactionFeed');
    const user = userRepo.findById(row.user_id);
    const label = row.type === 'onramp' ? 'MoonPay deposit (card)' : 'MoonPay cash-out (bank)';
    const fiatLine = data.quoteCurrencyAmount
      ? ` — ${data.quoteCurrencyAmount} ${(data.quoteCurrencyCode || 'USD').toUpperCase()}`
      : '';
    postTransaction({
      type: 'deposit', // re-use existing type for feed coloring
      username: user && user.server_username,
      discordId: user && user.discord_id,
      memo: `${label}: ${newStatus}${fiatLine}`,
    });
  } catch (err) {
    console.warn('[MoonPay] transaction feed post failed:', err.message);
  }
}

/**
 * Actually transfer USDC from the user's bot wallet to MoonPay's
 * off-ramp deposit address. Idempotent: if the row already has a
 * deposit_tx_signature we don't re-submit.
 *
 * Uses walletRepo.acquireLock to serialize against concurrent
 * withdrawals from the same user.
 */
async function _executeOfframpTransfer(rowId, destinationAddress, amountUsdcDecimal) {
  const row = db.prepare('SELECT * FROM moonpay_transactions WHERE id = ?').get(rowId);
  if (!row) {
    console.error(`[MoonPay] _executeOfframpTransfer: row ${rowId} not found`);
    return;
  }
  if (row.deposit_tx_signature) {
    console.log(`[MoonPay] Off-ramp row ${rowId} already submitted (${row.deposit_tx_signature})`);
    return;
  }

  // Defensive address check — MoonPay's deposit address should
  // always be a valid Solana address, but we pass through
  // walletManager.isAddressValid anyway so a malformed or blocked
  // address gets caught instead of firing a transfer into the void.
  if (!walletManager.isAddressValid(destinationAddress)) {
    console.error(`[MoonPay] Off-ramp row ${rowId} rejected invalid destination: ${destinationAddress}`);
    db.prepare('UPDATE moonpay_transactions SET status = ? WHERE id = ?').run('invalid_destination', rowId);
    return;
  }

  const wallet = walletRepo.findByUserId(row.user_id);
  if (!wallet) {
    console.error(`[MoonPay] Off-ramp row ${rowId}: wallet not found for user ${row.user_id}`);
    return;
  }

  // Convert decimal USDC ("10.50") to smallest units (BigInt 10500000)
  const [whole, frac = ''] = String(amountUsdcDecimal).split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const amountSmallest = BigInt(whole) * 1_000_000n + BigInt(fracPadded || '0');

  const freshAvail = BigInt(wallet.balance_available);
  if (amountSmallest > freshAvail) {
    console.error(`[MoonPay] Off-ramp row ${rowId}: user ${row.user_id} insufficient balance (need ${amountSmallest}, have ${freshAvail})`);
    db.prepare('UPDATE moonpay_transactions SET status = ? WHERE id = ?').run('insufficient_balance', rowId);
    return;
  }

  if (!walletRepo.acquireLock(row.user_id)) {
    console.warn(`[MoonPay] Off-ramp row ${rowId}: could not acquire wallet lock for user ${row.user_id}`);
    return;
  }

  try {
    const senderKp = walletManager.getKeypairFromEncrypted(
      wallet.encrypted_private_key,
      wallet.encryption_iv,
      wallet.encryption_tag,
      wallet.encryption_salt,
    );

    const { signature } = await transactionService.transferUsdc(
      senderKp,
      destinationAddress,
      amountSmallest.toString(),
    );

    // Debit the user's available balance (fresh read inside the
    // lock — the wallet may have shifted while we were waiting for
    // the RPC). Use the existing creditAvailable / held pattern
    // inverted: we hold the lock so a direct updateBalance is safe
    // here.
    const postWallet = walletRepo.findByUserId(row.user_id);
    const newAvail = (BigInt(postWallet.balance_available) - amountSmallest).toString();
    walletRepo.updateBalance(row.user_id, {
      balanceAvailable: newAvail,
      balanceHeld: postWallet.balance_held,
    });

    db.prepare(`
      UPDATE moonpay_transactions
      SET deposit_tx_signature = ?, status = 'processing', updated_at = datetime('now')
      WHERE id = ?
    `).run(signature, rowId);

    console.log(`[MoonPay] Off-ramp row ${rowId} submitted: ${signature}`);

    // Surface on the admin transactions feed
    try {
      const { postTransaction } = require('../utils/transactionFeed');
      const user = userRepo.findById(row.user_id);
      postTransaction({
        type: 'withdrawal',
        username: user && user.server_username,
        discordId: user && user.discord_id,
        amount: `$${(Number(amountSmallest) / USDC_PER_UNIT).toFixed(2)}`,
        currency: 'USDC',
        fromAddress: wallet.solana_address,
        toAddress: destinationAddress,
        signature,
        memo: `MoonPay off-ramp deposit submitted`,
      });
    } catch { /* non-fatal */ }
  } catch (err) {
    console.error(`[MoonPay] Off-ramp transfer exception for row ${rowId}:`, err.message);
    db.prepare('UPDATE moonpay_transactions SET status = ? WHERE id = ?').run('transfer_failed', rowId);
  } finally {
    walletRepo.releaseLock(row.user_id);
  }
}

module.exports = {
  initiateOnramp,
  initiateOfframp,
  handleWebhook,
};
