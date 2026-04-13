const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { Keypair } = require('@solana/web3.js');
const walletManager = require('../solana/walletManager');
const { getSolBalance, getUsdcBalance } = walletManager;
const transactionService = require('../solana/transactionService');
const { LAMPORTS_PER_SOL, USDC_PER_UNIT } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');

// Absolute minimum Solana needs to keep the account alive (rent-
// exempt minimum + one tx fee). No artificial buffer — if you want
// to drain your SOL you can drain your SOL.
const SOL_RESERVE_LAMPORTS = 895_880; // rent-exempt (890880) + tx fee (5000)

function getEscrowAddress() {
  const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
  if (!secretKeyJson) return null;
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
}

function _getEscrowKeypair() {
  const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
  if (!secretKeyJson) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
  } catch {
    return null;
  }
}

// Admin check — escrow actions require admin-equivalent role.
// Mirrors the chain of admin-equivalent env vars used elsewhere.
function _isAdminMember(member) {
  const roles = member && member.roles && member.roles.cache;
  if (!roles) return false;
  const ids = [
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
  ].filter(Boolean);
  return ids.some(id => roles.has(id));
}

async function buildEscrowPanel(lang = 'en') {
  const address = getEscrowAddress();
  if (!address) {
    return {
      embeds: [new EmbedBuilder().setTitle(t('escrow_panel.title', lang)).setColor(0xe74c3c).setDescription(t('escrow_panel.not_configured', lang))],
      components: [],
    };
  }

  let solBalance = '0';
  let usdcBalance = '0';
  try { solBalance = await getSolBalance(address); } catch { /* */ }
  try { usdcBalance = await getUsdcBalance(address); } catch { /* */ }

  const solFormatted = (Number(solBalance) / LAMPORTS_PER_SOL).toFixed(6);
  const usdcFormatted = (Number(usdcBalance) / USDC_PER_UNIT).toFixed(2);

  const db = require('../database/db');
  const activeMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting')").get()?.c || 0;
  const disputedMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'disputed'").get()?.c || 0;
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE accepted_tos = 1").get()?.c || 0;
  const activatedWallets = db.prepare("SELECT COUNT(*) as c FROM wallets WHERE is_activated = 1").get()?.c || 0;

  const embed = new EmbedBuilder()
    .setTitle(t('escrow_panel.title', lang))
    .setColor(0x2ecc71)
    .setDescription(`${t('escrow_panel.address_label', lang)}\n${address}`)
    .addFields(
      { name: t('escrow_panel.field_sol', lang), value: `${solFormatted} SOL`, inline: true },
      { name: t('escrow_panel.field_usdc', lang), value: `$${usdcFormatted} USDC`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: t('escrow_panel.field_active', lang), value: `${activeMatches}`, inline: true },
      { name: t('escrow_panel.field_disputed', lang), value: `${disputedMatches}`, inline: true },
      { name: t('escrow_panel.field_users', lang), value: `${totalUsers}`, inline: true },
      { name: t('escrow_panel.field_wallets', lang), value: `${activatedWallets}`, inline: true },
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('escrow_refresh')
      .setLabel(t('escrow_panel.btn_refresh', lang))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('escrow_copy_address')
      .setLabel(t('escrow_panel.btn_copy_address', lang))
      .setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('escrow_withdraw_sol')
      .setLabel('Withdraw SOL')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('escrow_withdraw_usdc')
      .setLabel('Withdraw USDC')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Helper: detect whether a bot message is the existing escrow panel by
 * looking for the `escrow_refresh` button customId in its components.
 * This lets the escrow panel coexist in the same channel as the admin
 * wallet viewer panel without one wiping the other on startup.
 */
function _isEscrowPanel(message) {
  if (!message.components || message.components.length === 0) return false;
  for (const row of message.components) {
    const comps = row.components || row.toJSON?.().components || [];
    for (const c of comps) {
      const id = c.customId || c.custom_id || c.data?.custom_id;
      if (id === 'escrow_refresh') return true;
    }
  }
  return false;
}

async function postEscrowPanel(client, lang = 'en') {
  // The escrow panel now lives in the same channel as the admin wallet
  // viewer panel — one consolidated admin wallet management channel.
  // Falls back to the legacy ESCROW_CHANNEL_ID for backward compat if
  // the new ADMIN_WALLET_VIEWER_CHANNEL_ID isn't set yet.
  const channelId = process.env.ADMIN_WALLET_VIEWER_CHANNEL_ID || process.env.ESCROW_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] ADMIN_WALLET_VIEWER_CHANNEL_ID not set — skipping escrow panel');
    return;
  }

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[Panel] Could not fetch escrow channel ${channelId}:`, err.message);
      return;
    }
  }
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 30 });
    const existingEscrow = messages.find(m => m.author.id === client.user.id && _isEscrowPanel(m));
    const panel = await buildEscrowPanel(lang);

    if (existingEscrow) {
      // Edit only the existing escrow panel — leave other bot messages
      // (like the admin wallet viewer panel) alone.
      await existingEscrow.edit(panel);
      console.log(`[Panel] Updated escrow panel (${lang})`);
    } else {
      await channel.send(panel);
      console.log(`[Panel] Posted escrow panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post escrow panel:', err.message);
  }
}

async function handleEscrowButton(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const sharedLang = getBotDisplayLanguage();

  if (!_isAdminMember(interaction.member)) {
    return interaction.reply({ content: t('escrow_panel.admin_only', lang), ephemeral: true });
  }

  if (id === 'escrow_refresh') {
    const panel = await buildEscrowPanel(sharedLang);
    return interaction.update(panel);
  }

  if (id === 'escrow_copy_address') {
    const address = getEscrowAddress();
    return interaction.reply({ content: address || t('escrow_panel.not_configured_short', lang), ephemeral: true });
  }

  // ─── Withdraw SOL button → show modal ───────────────────────
  if (id === 'escrow_withdraw_sol') {
    const modal = new ModalBuilder()
      .setCustomId('escrow_withdraw_sol_modal')
      .setTitle('Withdraw SOL from Escrow');
    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel('Destination Solana address')
      .setPlaceholder('e.g. 7xKXt...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);
    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel('Amount in SOL (e.g. 0.5)')
      .setPlaceholder('0.5')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(12);
    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(amountInput),
    );
    return interaction.showModal(modal);
  }

  // ─── Withdraw USDC button → show modal ──────────────────────
  if (id === 'escrow_withdraw_usdc') {
    const modal = new ModalBuilder()
      .setCustomId('escrow_withdraw_usdc_modal')
      .setTitle('Withdraw USDC from Escrow');
    const addressInput = new TextInputBuilder()
      .setCustomId('withdraw_address')
      .setLabel('Destination Solana address')
      .setPlaceholder('e.g. 7xKXt...')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(32)
      .setMaxLength(44);
    const amountInput = new TextInputBuilder()
      .setCustomId('withdraw_amount')
      .setLabel('Amount in USDC (e.g. 10.50)')
      .setPlaceholder('10.50')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(12);
    modal.addComponents(
      new ActionRowBuilder().addComponents(addressInput),
      new ActionRowBuilder().addComponents(amountInput),
    );
    return interaction.showModal(modal);
  }

  // ─── Cancel confirmation ────────────────────────────────────
  if (id === 'escrow_wd_cancel') {
    return interaction.update({
      content: 'Escrow withdrawal cancelled.',
      embeds: [],
      components: [],
    });
  }

  // ─── Confirm → execute the on-chain transfer ────────────────
  if (id.startsWith('escrow_wd_sol_') || id.startsWith('escrow_wd_usdc_')) {
    return _executeEscrowWithdrawConfirm(interaction);
  }
}

/**
 * Modal-submit handler for the SOL and USDC withdraw modals. Validates
 * input, builds a confirmation embed, returns it with Yes/Cancel buttons.
 * The actual on-chain transfer only fires after the user clicks Yes.
 */
async function handleEscrowModal(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  if (!_isAdminMember(interaction.member)) {
    return interaction.reply({ content: t('escrow_panel.admin_only', lang), ephemeral: true });
  }

  const address = interaction.fields.getTextInputValue('withdraw_address').trim();
  const amountStr = interaction.fields.getTextInputValue('withdraw_amount').trim();
  const amount = parseFloat(amountStr);

  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({
      content: '⚠️ Invalid or blocked destination address. Cannot withdraw to system programs, mints, or the escrow itself.',
      ephemeral: true,
    });
  }

  if (isNaN(amount) || amount <= 0) {
    return interaction.reply({
      content: '⚠️ Amount must be a positive number.',
      ephemeral: true,
    });
  }

  const escrowAddress = getEscrowAddress();
  if (!escrowAddress) {
    return interaction.reply({
      content: '⚠️ Escrow wallet not configured.',
      ephemeral: true,
    });
  }

  // Validate balance on-chain before showing the confirmation so the
  // admin sees a loud error immediately instead of at execute time.
  if (id === 'escrow_withdraw_sol_modal') {
    const solLamports = Number(await getSolBalance(escrowAddress));
    const requestedLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const availableLamports = solLamports - SOL_RESERVE_LAMPORTS;
    if (requestedLamports > availableLamports) {
      const availSol = (availableLamports / LAMPORTS_PER_SOL).toFixed(6);
      return interaction.reply({
        content: `⚠️ Insufficient SOL. Available after 0.005 SOL gas reserve: **${availSol} SOL**.`,
        ephemeral: true,
      });
    }

    const confirmEmbed = new EmbedBuilder()
      .setTitle('⚠️ Confirm Escrow SOL Withdrawal')
      .setColor(0xf39c12)
      .setDescription([
        'You are about to send **SOL** out of the escrow wallet:',
        '',
        `**Amount:** \`${amount} SOL\``,
        `**Destination:**\n\`\`\`\n${address}\n\`\`\``,
        '',
        `**Escrow balance after:** ~${((solLamports - requestedLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
        '',
        '⚠️ Crypto transfers cannot be reversed. Double-check the address.',
      ].join('\n'));

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`escrow_wd_sol_${amount}_${address}`)
        .setLabel('Yes, send it')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('escrow_wd_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
  }

  if (id === 'escrow_withdraw_usdc_modal') {
    const usdcSmallest = BigInt(await walletManager.getUsdcBalance(escrowAddress));
    const requestedSmallest = BigInt(Math.floor(amount * USDC_PER_UNIT));
    if (requestedSmallest > usdcSmallest) {
      const availUsdc = (Number(usdcSmallest) / USDC_PER_UNIT).toFixed(2);
      return interaction.reply({
        content: `⚠️ Insufficient USDC. Escrow on-chain balance: **$${availUsdc} USDC**.`,
        ephemeral: true,
      });
    }

    // Warn if there are live matches relying on escrow USDC.
    const db = require('../database/db');
    const liveMatchCount = db.prepare(
      "SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting', 'disputed')",
    ).get()?.c || 0;

    const liveWarning = liveMatchCount > 0
      ? `\n\n⚠️ **${liveMatchCount} live match(es)** depend on escrow USDC for disbursement. Withdrawing too much may cause resolution to fail.`
      : '';

    const remainingAfter = Number(usdcSmallest - requestedSmallest) / USDC_PER_UNIT;
    const confirmEmbed = new EmbedBuilder()
      .setTitle('⚠️ Confirm Escrow USDC Withdrawal')
      .setColor(0xf39c12)
      .setDescription([
        'You are about to send **USDC** out of the escrow wallet:',
        '',
        `**Amount:** \`$${amount.toFixed(2)} USDC\``,
        `**Destination:**\n\`\`\`\n${address}\n\`\`\``,
        '',
        `**Escrow balance after:** ~$${remainingAfter.toFixed(2)} USDC`,
        '',
        '⚠️ Crypto transfers cannot be reversed. Double-check the address.' + liveWarning,
      ].join('\n'));

    const fixedAmount = amount.toFixed(2);
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`escrow_wd_usdc_${fixedAmount}_${address}`)
        .setLabel('Yes, send it')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('escrow_wd_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
  }
}

/**
 * Execute the on-chain transfer after the admin confirms. CustomId
 * format: `escrow_wd_sol_{amount}_{address}` or `escrow_wd_usdc_...`.
 * Admin check runs again as defense-in-depth.
 */
async function _executeEscrowWithdrawConfirm(interaction) {
  const lang = langFor(interaction);

  if (!_isAdminMember(interaction.member)) {
    return interaction.reply({ content: t('escrow_panel.admin_only', lang), ephemeral: true });
  }

  // Parse: escrow_wd_{currency}_{amount}_{address}
  const afterPrefix = interaction.customId.substring('escrow_wd_'.length);
  const firstUnd = afterPrefix.indexOf('_');
  const currency = afterPrefix.substring(0, firstUnd);
  const rest = afterPrefix.substring(firstUnd + 1);
  const secondUnd = rest.indexOf('_');
  const amountStr = rest.substring(0, secondUnd);
  const address = rest.substring(secondUnd + 1);
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || !address) {
    return interaction.reply({ content: '⚠️ Parse error on confirm.', ephemeral: true });
  }

  // Re-validate the address at confirm time (defense in depth against
  // crafted customIds even though Discord signs interactions).
  if (!walletManager.isAddressValid(address)) {
    return interaction.reply({ content: '⚠️ Invalid or blocked destination address.', ephemeral: true });
  }

  const escrowKp = _getEscrowKeypair();
  if (!escrowKp) {
    return interaction.reply({ content: '⚠️ Escrow keypair not configured.', ephemeral: true });
  }

  // Swap confirmation for a "processing" notice while the on-chain
  // round-trip runs, then report the signature on return.
  await interaction.update({
    content: 'Processing escrow withdrawal…',
    embeds: [],
    components: [],
  });

  const { postTransaction } = require('../utils/transactionFeed');

  try {
    if (currency === 'sol') {
      const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
      const { signature } = await transactionService.transferSol(escrowKp, address, lamports);
      postTransaction({
        type: 'sol_withdrawal',
        discordId: interaction.user.id,
        amount: `${amount}`,
        currency: 'SOL',
        fromAddress: escrowKp.publicKey.toBase58(),
        toAddress: address,
        signature,
        memo: `🛠️ Admin escrow SOL withdraw by <@${interaction.user.id}>: ${amount} SOL`,
      });
      return interaction.editReply({
        content: `✅ Escrow SOL withdrawal complete.\n\n**Amount:** ${amount} SOL\n**To:** \`${address}\`\n**Signature:** \`${signature}\``,
        embeds: [],
        components: [],
      });
    }

    if (currency === 'usdc') {
      const amountSmallest = Math.floor(amount * USDC_PER_UNIT).toString();
      const { signature } = await transactionService.transferUsdc(escrowKp, address, amountSmallest);
      postTransaction({
        type: 'withdrawal',
        discordId: interaction.user.id,
        amount: `$${amount.toFixed(2)}`,
        currency: 'USDC',
        fromAddress: escrowKp.publicKey.toBase58(),
        toAddress: address,
        signature,
        memo: `🛠️ Admin escrow USDC withdraw by <@${interaction.user.id}>: $${amount.toFixed(2)} USDC`,
      });
      return interaction.editReply({
        content: `✅ Escrow USDC withdrawal complete.\n\n**Amount:** $${amount.toFixed(2)} USDC\n**To:** \`${address}\`\n**Signature:** \`${signature}\``,
        embeds: [],
        components: [],
      });
    }

    return interaction.editReply({ content: '⚠️ Unknown currency on confirm.', embeds: [], components: [] });
  } catch (err) {
    console.error('[Escrow] Withdrawal failed:', err);
    return interaction.editReply({
      content: `❌ Escrow withdrawal failed: ${err.message || err}`,
      embeds: [],
      components: [],
    });
  }
}

module.exports = { postEscrowPanel, handleEscrowButton, handleEscrowModal };
