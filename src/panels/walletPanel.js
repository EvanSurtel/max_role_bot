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
const walletManager = require('../base/walletManager');
const transactionService = require('../base/transactionService');
const { USDC_PER_UNIT, TRANSACTION_TYPE } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');
const changelly = require('../services/changellyService');

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

  const { buildWalletView } = require('./walletPanelView');
  const view = buildWalletView(wallet, user, lang);

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
    // Region-specific deposit instructions. Group A gets Coinbase
    // Onramp link (0% fee). Group B gets Changelly fiat on-ramp
    // (~4-5% fee). Falls back to generic if no region is set.
    const depositRegion = user.deposit_region || 'GROUP_B';
    const address = wallet.address;

    if (depositRegion === 'GROUP_A' && process.env.CDP_API_KEY) {
      // Coinbase Onramp URL — prefills the user's Base address + USDC
      const cdpAppId = process.env.CDP_API_KEY;
      const onrampUrl = `https://pay.coinbase.com/buy/select-asset?appId=${cdpAppId}&addresses={"${address}":["base"]}&assets=["USDC"]&presetFiatAmount=50&defaultPaymentMethod=CARD`;

      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setURL(onrampUrl)
          .setLabel('Buy USDC')
          .setStyle(ButtonStyle.Link),
      );

      return interaction.reply({
        content: [
          '**💳 Deposit USDC**',
          '',
          `Your deposit address (Base network):`,
          `\`\`\`\n${address}\n\`\`\``,
          '',
          '**Steps:**',
          '1. Click the button below — it opens Coinbase',
          '2. Enter the amount you want (minimum $5)',
          '3. Pay with card, Apple Pay, Google Pay, or bank transfer',
          '4. USDC arrives in your wallet within a few minutes — **0% fee**',
          '',
          '⚠️ Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
        ].join('\n'),
        components: [openButton],
        ephemeral: true,
      });
    }

    // Group B (or no CDP key) — Changelly fiat on-ramp
    if (changelly.isConfigured()) {
      try {
        await interaction.deferReply({ ephemeral: true });

        const order = await changelly.createOrder({
          userId: interaction.user.id,
          walletAddress: address,
          amountUsd: 50,
          countryCode: user.country_code || 'US',
        });

        if (order && order.redirectUrl) {
          const buyButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setURL(order.redirectUrl)
              .setLabel('Buy USDC')
              .setStyle(ButtonStyle.Link),
          );

          return interaction.editReply({
            content: [
              '**💳 Deposit USDC**',
              '',
              `Your deposit address (Base network):`,
              `\`\`\`\n${address}\n\`\`\``,
              '',
              '**Steps:**',
              '1. Click the button below — it opens the payment page',
              '2. Enter the amount you want (minimum ~$5)',
              '3. Pay with your card',
              '4. USDC arrives in your wallet within a few minutes',
              '',
              '💸 Fee: ~4-5% from the payment provider.',
              '',
              '⚠️ Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
            ].join('\n'),
            components: [buyButton],
          });
        }
      } catch (err) {
        console.error('[Wallet] Changelly order creation failed:', err);
      }

      // Changelly order failed — show fallback with manual instructions
      return interaction.editReply({
        content: [
          '**💳 Deposit USDC**',
          '',
          `Your deposit address (Base network):`,
          `\`\`\`\n${address}\n\`\`\``,
          '',
          'We could not generate a payment link right now. You can still deposit by buying USDC on any exchange (Binance, Bybit, Coinbase, etc.) and sending it to your address above.',
          '',
          '⚠️ Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
        ].join('\n'),
      });
    }

    // Changelly not configured — fallback manual instructions
    return interaction.reply({
      content: [
        '**💳 Deposit USDC**',
        '',
        `Your deposit address (Base network):`,
        `\`\`\`\n${address}\n\`\`\``,
        '',
        'Buy USDC on any exchange (Binance, Bybit, Coinbase, etc.) and send it to your address above.',
        '',
        '⚠️ Make sure to send USDC on the **Base** network. Sending on the wrong network will result in permanent loss of funds.',
      ].join('\n'),
      ephemeral: true,
    });
  }

  // Withdraw menu — pick between cash-to-fiat (offramp) or send-to-wallet.
  // Both subflows are existing handlers (wallet_cashout / wallet_withdraw),
  // we just give the user the choice instead of two top-level buttons.
  if (id === 'wallet_withdraw_menu') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wallet_cashout')
        .setLabel(t('wallet.withdraw_choice_btn_fiat', lang))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('wallet_withdraw')
        .setLabel(t('wallet.withdraw_choice_btn_send', lang))
        .setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: t('wallet.withdraw_choice_prompt', lang),
      components: [row],
      ephemeral: true,
    });
  }

  if (id === 'wallet_cashout') {
    const depositRegion = user.deposit_region || 'GROUP_B';
    const address = wallet.address;

    if (depositRegion === 'GROUP_A' && process.env.CDP_API_KEY) {
      const cdpAppId = process.env.CDP_API_KEY;
      const offrampUrl = `https://pay.coinbase.com/sell/select-asset?appId=${cdpAppId}&addresses={"${address}":["base"]}&assets=["USDC"]`;

      const openButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setURL(offrampUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
      );

      return interaction.reply({
        content: [
          '**💸 Cash Out**',
          '',
          '1. Click the button below — it opens Coinbase',
          '2. Select how much USDC to sell',
          '3. Choose your payout method (bank, PayPal, etc.)',
          '4. Cash arrives in your account within minutes',
        ].join('\n'),
        components: [openButton],
        ephemeral: true,
      });
    }

    // Group B — Changelly off-ramp
    if (changelly.isConfigured()) {
      try {
        await interaction.deferReply({ ephemeral: true });
        const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
        const result = await changelly.createSellOrder({
          userId: user.discord_id,
          walletAddress: address,
          amountUsdc: availableUsdc,
          countryCode: user.country_code || 'US',
        });

        if (result?.redirectUrl) {
          const openButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setURL(result.redirectUrl).setLabel('Cash Out USDC').setStyle(ButtonStyle.Link),
          );

          return interaction.editReply({
            content: [
              '**💸 Cash Out**',
              '',
              '1. Click the button below',
              '2. Select how much USDC to sell',
              '3. Choose your payout method',
              '4. Cash arrives in your account',
            ].join('\n'),
            components: [openButton],
          });
        }
      } catch (err) {
        console.warn(`[Wallet] Changelly sell order failed: ${err.message}`);
      }
    }

    // Fallback — manual instructions
    return interaction.reply({
      content: [
        '**💸 Cash Out**',
        '',
        'To convert your USDC to cash:',
        '1. Click **Send** to withdraw USDC to an exchange (Binance, Coinbase, etc.)',
        '2. Make sure to send to your exchange\'s **USDC deposit address on the Base network**',
        '3. Sell USDC for your local currency and withdraw to your bank',
      ].join('\n'),
      ephemeral: true,
    });
  }

  if (id === 'wallet_copy_address') {
    // Wrap the address in a triple-backtick code block. On Discord desktop
    // this shows a built-in Copy button in the top-right of the block; on
    // mobile the address inside can still be long-pressed to copy.
    return interaction.reply({
      content: `\`\`\`\n${wallet.address}\n\`\`\``,
      ephemeral: true,
    });
  }

  // MoonPay was removed. These customIds are dead — the stub
  // moonpay.js returns isConfigured()=false so the buttons never
  // render, but catch any stale cached ephemeral that might still
  // have them.
  if (id === 'wallet_moonpay_deposit' || id === 'wallet_moonpay_withdraw') {
    return interaction.reply({
      content: 'This feature is no longer available.',
      ephemeral: true,
    });
  }

  if (id === 'wallet_refresh') {
    // Rate limit: 5 manual refreshes / hour. Not on-chain (just a
    // DB re-read), but stops button-mashing and gives abuse signal.
    const rateLimiter = require('../utils/rateLimiter');
    const q = rateLimiter.checkQuota(user.discord_id, 'WALLET_REFRESH_PER_HOUR');
    if (q.blocked) {
      rateLimiter.trackBlock(user.discord_id, `wallet_refresh (${q.hits}/${q.max})`);
      const mins = Math.ceil(q.remainingSeconds / 60);
      return interaction.reply({
        content: `🔄 Too many refreshes. Wallet balance auto-updates every 30s in the background. Try again in ${mins} min.`,
        ephemeral: true,
        _autoDeleteMs: 60_000,
      });
    }
    rateLimiter.recordQuota(user.discord_id, 'WALLET_REFRESH_PER_HOUR');

    // Re-render the ephemeral wallet view in place with fresh balance data.
    await interaction.deferUpdate();

    // Re-fetch wallet to pick up any balance changes
    const freshWallet = walletRepo.findByUserId(user.id);
    const { buildWalletView } = require('./walletPanelView');
    const view = buildWalletView(freshWallet, user, lang);
    return interaction.editReply(view);
  }

  if (id === 'wallet_withdraw_sol') {
    const { ethers } = require('ethers');
    let ethDisplay = '0';
    let maxEth = '0';
    try {
      const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
      ethDisplay = ethers.formatEther(ethBalWei);
      const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
      const maxWei = ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n;
      maxEth = ethers.formatEther(maxWei);
    } catch { /* fallback to 0 */ }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wallet_sol_max')
        .setLabel(`Send Max (${maxEth} ETH)`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('wallet_sol_custom')
        .setLabel('Custom Amount')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({
      content: `**ETH Balance:** ${ethDisplay} ETH\n**Max withdrawable:** ${maxEth} ETH\n\nChoose an option:`,
      components: [row],
      ephemeral: true,
    });
  }

  // Max SOL → address-only modal, amount calculated at execution time
  if (id === 'wallet_sol_max') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_sol_max_modal')
      .setTitle('Withdraw Max ETH');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('withdraw_address')
          .setLabel('Destination Base address')
          .setPlaceholder('0x...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(42)
          .setMaxLength(42),
      ),
    );
    return interaction.showModal(modal);
  }

  // Custom SOL amount → normal modal with address + amount
  if (id === 'wallet_sol_custom') {
    const modal = new ModalBuilder()
      .setCustomId('wallet_withdraw_sol_modal')
      .setTitle(t('wallet.withdraw_modal_title_sol', lang));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('withdraw_address')
          .setLabel(t('wallet.withdraw_address_label', lang))
          .setPlaceholder(t('wallet.withdraw_address_placeholder', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(42)
          .setMaxLength(42),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('withdraw_amount')
          .setLabel(t('wallet.withdraw_amount_label_sol', lang))
          .setPlaceholder(t('wallet.withdraw_amount_placeholder_sol', lang))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(20),
      ),
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
      .setMinLength(42)
      .setMaxLength(42);

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

  // Rate limit: 3 withdrawals / 24h + 60s global on-chain cooldown.
  // Hits are recorded on success (after the on-chain tx) so that a
  // failed attempt doesn't count against the user's quota.
  const rateLimiter = require('../utils/rateLimiter');
  const guard = rateLimiter.guardOnchainAction(user.discord_id, 'WITHDRAW_PER_24H', 'Withdraw');
  if (guard.blocked) {
    return interaction.editReply({ content: guard.message, embeds: [], components: [] });
  }

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({ content: t('common.please_wait', lang) });
  }

  try {
    const freshWallet = walletRepo.findByUserId(user.id);
    const freshAvailable = BigInt(freshWallet.balance_available);
    const amountBig = BigInt(amountSmallest);
    if (amountBig > freshAvailable) {
      walletRepo.releaseLock(user.id);
      const availableFormatted = (Number(freshAvailable) / USDC_PER_UNIT).toFixed(2);
      return interaction.editReply({ content: t('common.insufficient_balance', lang, { available: availableFormatted }) });
    }

    // Pre-log the withdrawal intent BEFORE sending on-chain. If the
    // bot crashes after the tx lands but before the DB debit, the
    // pending_onchain row tells the reconciliation service what
    // happened — prevents the user from spending the same USDC
    // again in a match (their DB balance would still show the old
    // amount, but the pending row is the audit trail).
    const pendingRow = transactionRepo.create({
      type: TRANSACTION_TYPE.WITHDRAWAL,
      userId: user.id,
      amountUsdc: amountSmallest.toString(),
      txHash: null,
      fromAddress: freshWallet.address,
      toAddress: address,
      status: 'pending_onchain',
      memo: `Withdrawal of $${amountUsdc} USDC — tx pending`,
    });

    // Debit DB BEFORE the on-chain transfer. This is safer than
    // debiting after: if the tx fails, we re-credit (no double-
    // spend window). If the tx succeeds but the bot dies before
    // re-crediting on failure, the user loses the amount from their
    // DB balance — but the on-chain tx also failed, so the funds
    // are still in their wallet on-chain. The deposit poller will
    // eventually re-credit the delta.
    const newAvailable = (freshAvailable - amountBig).toString();
    walletRepo.updateBalance(user.id, {
      balanceAvailable: newAvailable,
      balanceHeld: freshWallet.balance_held,
    });

    let signature;
    try {
      const result = await transactionService.transferUsdc(
        freshWallet.address,
        address,
        amountSmallest.toString(),
        { ownerRef: freshWallet.account_ref, smartRef: freshWallet.smart_account_ref },
      );
      signature = result.signature;
    } catch (txErr) {
      // On-chain transfer failed. Re-credit the DB balance we just
      // debited so the user's available balance is restored.
      try {
        walletRepo.creditAvailable(user.id, amountSmallest.toString());
      } catch { /* best-effort — deposit poller catches it if this fails */ }
      transactionRepo.updateStatusAndHash(pendingRow.id, 'failed', null, `Withdrawal failed: ${txErr.message}`);
      throw txErr;
    }

    // On-chain succeeded — finalize the pre-logged row.
    transactionRepo.updateStatusAndHash(pendingRow.id, 'completed', signature, `Withdrawal of $${amountUsdc} USDC`);

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'withdrawal', username: user.server_username, discordId: user.discord_id, amount: `$${amountUsdc.toFixed(2)}`, currency: 'USDC', fromAddress: freshWallet.address, toAddress: address, signature, memo: `Withdrawal of $${amountUsdc.toFixed(2)} USDC` });

    // Record rate-limit hit only after the on-chain tx + DB updates
    // succeed. Failed attempts don't consume the quota.
    rateLimiter.recordOnchainAction(user.discord_id);
    rateLimiter.recordQuota(user.discord_id, 'WITHDRAW_PER_24H');

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
  const { ethers } = require('ethers');
  const amountWei = ethers.parseEther(String(amountSol));

  if (!walletRepo.acquireLock(user.id)) {
    return interaction.editReply({
      content: t('common.please_wait', lang),
      embeds: [],
      components: [],
    });
  }

  try {
    const wallet = walletRepo.findByUserId(user.id);
    const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
    // Minimal reserve — just enough for the gas cost of this tx.
    const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
    if (amountWei > ethBalWei - reserveWei) {
      walletRepo.releaseLock(user.id);
      const availEth = ethers.formatEther(ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n);
      return interaction.editReply({
        content: `Insufficient ETH. Available after gas reserve: **${availEth} ETH**.`,
        embeds: [],
        components: [],
      });
    }

    const { signature } = await transactionService.transferEth(
      wallet.address, address, amountWei,
    );

    transactionRepo.create({
      type: 'eth_withdrawal',
      userId: user.id,
      amountUsdc: '0',
      txHash: signature,
      fromAddress: wallet.address,
      toAddress: address,
      status: 'completed',
      memo: `ETH withdrawal: ${amountSol} ETH`,
    });

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'eth_withdrawal', username: user.server_username, discordId: user.discord_id, amount: `${amountSol}`, currency: 'ETH', fromAddress: wallet.address, toAddress: address, signature, memo: `ETH withdrawal: ${amountSol} ETH` });

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

/**
 * Handle the "Send Max" SOL modal — only has an address field, no
 * amount. Calculates the max withdrawable SOL fresh at execution
 * time and goes straight to the confirmation embed.
 */
async function handleWithdrawSolMaxModal(interaction) {
  const lang = langFor(interaction);
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.onboarding_required', lang), ephemeral: true });

  const wallet = walletRepo.findByUserId(user.id);
  if (!wallet) return interaction.reply({ content: t('common.wallet_not_found', lang), ephemeral: true });

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: t('common.invalid_address', lang), ephemeral: true });
  }

  // Calculate max fresh right now
  const { ethers } = require('ethers');
  const ethBalWei = BigInt(await walletManager.getEthBalance(wallet.address));
  const reserveWei = 100_000_000_000_000n; // 0.0001 ETH
  const maxWei = ethBalWei > reserveWei ? ethBalWei - reserveWei : 0n;
  if (maxWei <= 0n) {
    return interaction.reply({
      content: 'No ETH available to withdraw after gas fees.',
      ephemeral: true,
    });
  }

  const amountSol = ethers.formatEther(maxWei);

  // Show confirmation with Yes/Cancel — same pattern as regular withdraw
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

module.exports = { handleWalletViewOpen, handleWalletSubButton, handleWithdrawModal, handleWithdrawSolModal, handleWithdrawSolMaxModal, handleWithdrawConfirmButton };
