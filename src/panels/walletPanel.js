const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../solana/walletManager');
const transactionService = require('../solana/transactionService');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');

/**
 * Handle the "View My Wallet" button click from the public wallet channel.
 *
 * Sends an ephemeral message with the clicker's wallet view (balance,
 * address, action buttons) in their own language. Only the clicker sees it.
 * The ephemeral is persistent (does not auto-delete) so the user can use
 * the action buttons without the message disappearing.
 */
async function handleWalletViewOpen(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const { buildWalletView } = require('./walletPanelView');
  const view = buildWalletView(wallet, user, lang, solBalance);

  // _persist: true — the wallet ephemeral must not auto-delete so the user
  // can click Copy Address / Withdraw / History on it without losing it.
  await interaction.reply({
    ...view,
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Handle wallet sub-buttons on the ephemeral wallet view (copy address,
 * withdraw, history, refresh). Always resolves the user via interaction.user.id
 * since there are no per-user wallet channels anymore — the ephemeral is
 * already scoped to the clicker.
 */
async function handleWalletSubButton(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  // Withdrawal confirmation buttons — handled by a dedicated function
  // that parses the validated amount/address out of the customId and
  // runs the actual on-chain transfer only after the user confirms.
  if (id === 'wallet_wd_cancel' || id.startsWith('wallet_wd_usdc_') || id.startsWith('wallet_wd_sol_')) {
    return handleWithdrawConfirmButton(interaction);
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.user_not_found', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  if (id === 'wallet_deposit') {
    return interaction.reply({
      content: t('wallet.deposit_info', lang, { address: wallet.solana_address }),
      ephemeral: true,
    });
  }

  if (id === 'wallet_copy_address') {
    // Wrap the address in a triple-backtick code block. On Discord desktop
    // this shows a built-in Copy button in the top-right of the block; on
    // mobile the address inside can still be long-pressed to copy.
    return interaction.reply({
      content: `\`\`\`\n${wallet.solana_address}\n\`\`\``,
      ephemeral: true,
    });
  }

  // ─── MoonPay: Deposit with Credit/Debit Card ──────────────
  // Generates a signed MoonPay on-ramp widget URL with the user's
  // Solana wallet address pre-filled. When they complete the
  // purchase, USDC lands in their bot wallet and the existing
  // deposit poller credits them within ~30 seconds — same flow
  // as any other deposit. MoonPay webhooks provide status updates
  // on the admin transactions feed; they're not required for the
  // USDC crediting.
  if (id === 'wallet_moonpay_deposit') {
    const moonpay = require('../services/moonpay');
    if (!moonpay.isConfigured()) {
      return interaction.reply({
        content: '💳 Card deposits are not configured yet. Ask an admin to set up MoonPay.',
        ephemeral: true,
      });
    }
    try {
      const moonpayService = require('../services/moonpayService');
      const { url } = moonpayService.initiateOnramp(user.id);
      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setURL(url)
          .setLabel('Open MoonPay')
          .setStyle(ButtonStyle.Link),
      );
      const envLabel = moonpay.getEnvLabel();
      const envWarning = envLabel !== 'production'
        ? `\n\n⚠️ **SANDBOX MODE** — use MoonPay's test card numbers, no real money will move.`
        : '';
      return interaction.reply({
        content:
          `💳 **Deposit with Credit/Debit Card**\n\n` +
          `Click the button below to open MoonPay in your browser. You'll choose an amount, pay with your card, ` +
          `Apple Pay, or Google Pay, and the USDC will land in your bot wallet automatically — usually within a ` +
          `few minutes.\n\n` +
          `Your wallet address is already pre-filled. You don't need to copy anything.` +
          envWarning,
        components: [openButton],
        ephemeral: true,
      });
    } catch (err) {
      console.error('[Wallet] MoonPay on-ramp error:', err);
      return interaction.reply({
        content: `Could not start MoonPay deposit: ${err.message || err}`,
        ephemeral: true,
      });
    }
  }

  // ─── MoonPay: Cash Out to Bank (off-ramp) ─────────────────
  // Opens a signed MoonPay off-ramp widget URL. User fills out
  // bank/card details on MoonPay's hosted page; MoonPay creates
  // a sell transaction and the bot receives webhook callbacks.
  // When MoonPay sends a `waitingForDeposit` webhook with a
  // deposit address, moonpayService._executeOfframpTransfer
  // signs a USDC transfer from the user's bot wallet to that
  // address and MoonPay pays the user's bank.
  if (id === 'wallet_moonpay_withdraw') {
    const moonpay = require('../services/moonpay');
    // Full off-ramp readiness check (API keys + webhook secret +
    // public webhook URL). Off-ramp CANNOT work without webhooks
    // because MoonPay delivers the deposit address via webhook,
    // so we refuse here even if the button somehow reached the
    // user via a stale cached message.
    if (!moonpay.isOfframpConfigured()) {
      return interaction.reply({
        content: '🏦 Bank cash-outs are not fully set up yet. Ask an admin to finish MoonPay webhook configuration.',
        ephemeral: true,
      });
    }
    try {
      const moonpayService = require('../services/moonpayService');
      const { url } = moonpayService.initiateOfframp(user.id /* no fixed amount — user picks on MoonPay's page */);
      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setURL(url)
          .setLabel('Open MoonPay')
          .setStyle(ButtonStyle.Link),
      );
      const envLabel = moonpay.getEnvLabel();
      const envWarning = envLabel !== 'production'
        ? `\n\n⚠️ **SANDBOX MODE** — no real money will move.`
        : '';
      return interaction.reply({
        content:
          `🏦 **Cash Out to Bank**\n\n` +
          `Click the button below to open MoonPay in your browser. You'll enter your bank details and the ` +
          `amount you want, and MoonPay will walk you through the rest. The bot will send the required USDC ` +
          `automatically when MoonPay is ready — you don't need to copy any addresses.\n\n` +
          `Make sure you have enough USDC in your wallet to cover the cash-out amount plus MoonPay's fee.` +
          envWarning,
        components: [openButton],
        ephemeral: true,
      });
    } catch (err) {
      console.error('[Wallet] MoonPay off-ramp error:', err);
      return interaction.reply({
        content: `Could not start MoonPay cash-out: ${err.message || err}`,
        ephemeral: true,
      });
    }
  }

  if (id === 'wallet_refresh') {
    // Re-render the ephemeral wallet view in place with fresh balance data.
    await interaction.deferUpdate();

    let solBalance = '0';
    try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

    // Re-fetch wallet to pick up any balance changes
    const freshWallet = walletRepo.findByUserId(user.id);
    const { buildWalletView } = require('./walletPanelView');
    const view = buildWalletView(freshWallet, user, lang, solBalance);
    return interaction.editReply(view);
  }

  if (id === 'wallet_withdraw_sol') {
    // Pre-fill the amount field with the max withdrawable SOL so the
    // user can just paste their address and hit submit without doing
    // any math. Max = on-chain balance minus rent-exempt + tx fee.
    let maxSol = '';
    try {
      const solBalance = Number(await walletManager.getSolBalance(wallet.solana_address));
      const reserveLamports = 895_880; // rent-exempt (890880) + tx fee (5000)
      const maxLamports = Math.max(0, solBalance - reserveLamports);
      if (maxLamports > 0) {
        maxSol = (maxLamports / 1_000_000_000).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
      }
    } catch { /* leave empty — user types manually */ }

    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_sol_modal')
      .setTitle(t('wallet.withdraw_modal_title_sol', lang));

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel(t('wallet.withdraw_address_label', lang))
      .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel(maxSol ? `Max: ${maxSol} SOL` : t('wallet.withdraw_amount_label_sol', lang))
      .setPlaceholder(t('wallet.withdraw_amount_placeholder_sol', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(20);
    if (maxSol) amountInput.setValue(maxSol);

    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(amountInput),
    );

    return interaction.showModal(modal);
  }

  if (id === 'wallet_withdraw') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_modal')
      .setTitle(t('wallet.withdraw_modal_title_usdc', lang));

    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel(t('wallet.withdraw_address_label', lang))
      .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);

    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel(t('wallet.withdraw_amount_label_usdc', lang))
      .setPlaceholder(t('wallet.withdraw_amount_placeholder_usdc', lang))
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(10);

    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(amountInput),
    );

    return interaction.showModal(modal);
  }

  if (id === 'wallet_history' || id.startsWith('wallet_history_page_')) {
    const transactions = transactionRepo.findByUserId(user.id).reverse(); // newest first
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(transactions.length / pageSize));

    let page = 0;
    if (id.startsWith('wallet_history_page_')) {
      page = parseInt(id.replace('wallet_history_page_', ''), 10) || 0;
    }
    if (page < 0) page = 0;
    if (page >= totalPages) page = totalPages - 1;

    if (transactions.length === 0) {
      return interaction.reply({ content: t('wallet.history_empty', lang), ephemeral: true });
    }

    const pageItems = transactions.slice(page * pageSize, (page + 1) * pageSize);
    const lines = pageItems.map((tx, i) => {
      const num = page * pageSize + i + 1;
      const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
      const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
      const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' || tx.type === 'sol_withdrawal' ? '📤' : '🔄';
      // User-friendly translated label, e.g. "escrow_in" → "Match Entry"
      const typeLabel = t(`tx_type.${tx.type}`, lang);
      return `${num}. ${icon} **${typeLabel}** — $${amountUsdc} USDC — ${date}`;
    });

    const navRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page - 1}`)
        .setLabel(t('common.previous', lang))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`wallet_history_page_${page + 1}`)
        .setLabel(t('common.next', lang))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );

    const header = `**${t('wallet.history_title', lang)}** (${t('wallet.history_page', lang, { page: page + 1, total: totalPages, count: transactions.length })})`;
    const content = `${header}\n\n${lines.join('\n')}`;

    if (id === 'wallet_history') {
      return interaction.reply({ content, components: [navRow], ephemeral: true });
    } else {
      return interaction.update({ content, components: [navRow] });
    }
  }
}

/**
 * Handle the USDC withdraw modal submission. Validates input then
 * shows a confirmation embed with the amount + destination address.
 * The actual transfer runs only after the user clicks "Yes, send it"
 * on the confirmation — see handleWithdrawConfirmButton + _executeUsdcWithdraw.
 */
async function handleWithdrawModal(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amountUsdc = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  if (isNaN(amountUsdc) || amountUsdc <= 0) {
    return interaction.reply({ content: t('common.amount_must_be_positive', lang), ephemeral: true });
  }

  const amountSmallest = Math.floor(amountUsdc * USDC_PER_UNIT);
  const availableSmallest = Number(wallet.balance_available);

  if (amountSmallest > availableSmallest) {
    const availableFormatted = (availableSmallest / USDC_PER_UNIT).toFixed(2);
    return interaction.reply({
      content: t('common.insufficient_balance', lang, { available: availableFormatted }),
      ephemeral: true,
    });
  }

  // Show confirmation embed with Yes/Cancel buttons. The validated
  // amount + address are encoded into the Yes button's customId so
  // we don't have to stash them in server-side state.
  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('wallet.withdraw_confirm_title', lang))
    .setColor(0xf39c12)
    .setDescription(t('wallet.withdraw_confirm_desc_usdc', lang, {
      amount: amountUsdc.toFixed(2),
      address,
    }));

  const fixedAmount = amountUsdc.toFixed(2);
  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_wd_usdc_${fixedAmount}_${address}`)
      .setLabel(t('wallet.withdraw_confirm_btn_yes', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_wd_cancel')
      .setLabel(t('wallet.withdraw_confirm_btn_cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({
    embeds: [confirmEmbed],
    components: [confirmRow],
    ephemeral: true,
  });
}

/**
 * Actually transfer USDC on-chain. Called from handleWithdrawConfirmButton
 * once the user has confirmed the confirmation embed. The interaction
 * passed here is the BUTTON click interaction — it's already been
 * deferred/updated to the "processing" state before this runs.
 */
async function _executeUsdcWithdraw(interaction, user, amountUsdc, address, lang) {
  const amountSmallest = Math.floor(amountUsdc * USDC_PER_UNIT);

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({ content: t('common.please_wait', lang) });
  }

  try {
    const freshWallet = walletRepo.findByUserId(user.id);
    const freshAvailable = Number(freshWallet.balance_available);
    if (amountSmallest > freshAvailable) {
      walletRepo.releaseLock(user.id);
      const availableFormatted = (freshAvailable / USDC_PER_UNIT).toFixed(2);
      return interaction.editReply({ content: t('common.insufficient_balance', lang, { available: availableFormatted }) });
    }

    const senderKeypair = walletManager.getKeypairFromEncrypted(
      freshWallet.encrypted_private_key,
      freshWallet.encryption_iv,
      freshWallet.encryption_tag,
      freshWallet.encryption_salt,
    );

    const { signature } = await transactionService.transferUsdc(
      senderKeypair,
      address,
      amountSmallest.toString(),
    );

    const newAvailable = (freshAvailable - amountSmallest).toString();
    walletRepo.updateBalance(user.id, {
      balanceAvailable: newAvailable,
      balanceHeld: freshWallet.balance_held,
    });

    transactionRepo.create({
      type: TRANSACTION_TYPE.WITHDRAWAL,
      userId: user.id,
      amountUsdc: amountSmallest.toString(),
      solanaTxSignature: signature,
      fromAddress: freshWallet.solana_address,
      toAddress: address,
      status: 'completed',
      memo: `Withdrawal of $${amountUsdc} USDC`,
    });

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'withdrawal', username: user.server_username, discordId: user.discord_id, amount: `$${amountUsdc.toFixed(2)}`, currency: 'USDC', fromAddress: freshWallet.solana_address, toAddress: address, signature, memo: `Withdrawal of $${amountUsdc.toFixed(2)} USDC` });

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: t('wallet.withdraw_success_usdc', lang, { amount: amountUsdc.toFixed(2), address, signature }),
      embeds: [],
      components: [],
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] Withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang), embeds: [], components: [] });
  }
}

/**
 * Handle the SOL withdraw modal submission. Validates input and shows
 * a confirmation embed with the destination address. The actual
 * transfer runs only after the user confirms — see
 * handleWithdrawConfirmButton + _executeSolWithdraw.
 */
async function handleWithdrawSolModal(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) {
    return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amountSol = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  if (isNaN(amountSol) || amountSol <= 0) {
    return interaction.reply({ content: t('common.amount_must_be_positive', lang), ephemeral: true });
  }

  // Show confirmation embed with Yes/Cancel buttons.
  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('wallet.withdraw_confirm_title', lang))
    .setColor(0xf39c12)
    .setDescription(t('wallet.withdraw_confirm_desc_sol', lang, {
      amount: amountSol,
      address,
    }));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_wd_sol_${amountSol}_${address}`)
      .setLabel(t('wallet.withdraw_confirm_btn_yes', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wallet_wd_cancel')
      .setLabel(t('wallet.withdraw_confirm_btn_cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({
    embeds: [confirmEmbed],
    components: [confirmRow],
    ephemeral: true,
  });
}

/**
 * Actually transfer SOL on-chain. Called from handleWithdrawConfirmButton
 * once the user has confirmed the confirmation embed.
 *
 * Holds walletRepo.acquireLock for the duration of the on-chain submit
 * so a user clicking "Yes, send it" twice in rapid succession can't
 * race through two transferSol calls before the first one settles.
 * The USDC withdraw path already did this; SOL withdraw was missing
 * the lock and could be double-spent.
 */
async function _executeSolWithdraw(interaction, user, amountSol, address, lang) {
  const lamports = Math.floor(amountSol * 1_000_000_000);

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({
      content: t('common.please_wait', lang),
      embeds: [],
      components: [],
    });
  }

  try {
    // Re-fetch the wallet AFTER taking the lock — protects against the
    // case where another flow updated the wallet row between when the
    // confirmation embed was built and when the user clicked Yes.
    const wallet = walletRepo.findByUserId(user.id);
    const solBalance = Number(await walletManager.getSolBalance(wallet.solana_address));
    // Only reserve enough for the rent-exempt minimum + this tx fee.
    // No artificial reserve — if the user wants to drain their SOL
    // they can drain their SOL.
    const reserveLamports = 895_880; // rent-exempt (890880) + tx fee (5000)
    if (lamports > solBalance - reserveLamports) {
      walletRepo.releaseLock(user.id);
      const availSol = ((solBalance - reserveLamports) / 1_000_000_000).toFixed(8);
      return interaction.editReply({
        content: t('common.insufficient_sol', lang, { available: availSol }),
        embeds: [],
        components: [],
      });
    }

    const senderKeypair = walletManager.getKeypairFromEncrypted(
      wallet.encrypted_private_key,
      wallet.encryption_iv,
      wallet.encryption_tag,
      wallet.encryption_salt,
    );

    const { signature } = await transactionService.transferSol(senderKeypair, address, lamports);

    transactionRepo.create({
      type: 'sol_withdrawal',
      userId: user.id,
      amountUsdc: '0',
      solanaTxSignature: signature,
      fromAddress: wallet.solana_address,
      toAddress: address,
      status: 'completed',
      memo: `SOL withdrawal: ${amountSol} SOL (${lamports} lamports)`,
    });

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'sol_withdrawal', username: user.server_username, discordId: user.discord_id, amount: `${amountSol}`, currency: 'SOL', fromAddress: wallet.solana_address, toAddress: address, signature, memo: `SOL withdrawal: ${amountSol} SOL` });

    walletRepo.releaseLock(user.id);
    return interaction.editReply({
      content: t('wallet.withdraw_success_sol', lang, { amount: amountSol, address, signature }),
      embeds: [],
      components: [],
    });
  } catch (err) {
    walletRepo.releaseLock(user.id);
    console.error('[Wallet] SOL withdrawal error:', err);
    return interaction.editReply({ content: t('wallet.withdraw_failed', lang), embeds: [], components: [] });
  }
}

/**
 * Handle Confirm / Cancel button clicks on the withdrawal confirmation
 * embed. CustomId formats:
 *   wallet_wd_usdc_{amount}_{address}
 *   wallet_wd_sol_{amount}_{address}
 *   wallet_wd_cancel
 *
 * The validated amount and destination address are encoded into the
 * customId at the time the confirmation embed is shown, so the click
 * is self-contained — no server-side state to coordinate or expire.
 */
async function handleWithdrawConfirmButton(interaction) {
  const lang = langFor(interaction);
  const id = interaction.customId;

  if (id === 'wallet_wd_cancel') {
    return interaction.update({
      content: t('wallet.withdraw_cancelled', lang),
      embeds: [],
      components: [],
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });
  }

  // wallet_wd_<currency>_<amount>_<address>
  const afterPrefix = id.substring('wallet_wd_'.length);
  const firstUnd = afterPrefix.indexOf('_');
  const currency = afterPrefix.substring(0, firstUnd); // 'usdc' or 'sol'
  const rest = afterPrefix.substring(firstUnd + 1);
  const secondUnd = rest.indexOf('_');
  const amountStr = rest.substring(0, secondUnd);
  const address = rest.substring(secondUnd + 1);
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || !address) {
    return interaction.reply({ content: t('wallet.withdraw_failed', lang), ephemeral: true });
  }

  // Swap the confirmation embed for a "processing…" notice while
  // the on-chain transfer runs, then editReply with the final result.
  await interaction.update({
    content: t('wallet.withdraw_processing', lang),
    embeds: [],
    components: [],
  });

  if (currency === 'usdc') {
    return _executeUsdcWithdraw(interaction, user, amount, address, lang);
  }
  if (currency === 'sol') {
    return _executeSolWithdraw(interaction, user, amount, address, lang);
  }
}

module.exports = { handleWalletViewOpen, handleWalletSubButton, handleWithdrawModal, handleWithdrawSolModal, handleWithdrawConfirmButton };
