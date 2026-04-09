const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Keypair } = require('@solana/web3.js');
const { getSolBalance, getUsdcBalance } = require('../solana/walletManager');
const { LAMPORTS_PER_SOL, USDC_PER_UNIT } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');

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

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('escrow_refresh')
      .setLabel(t('escrow_panel.btn_refresh', lang))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('escrow_copy_address')
      .setLabel(t('escrow_panel.btn_copy_address', lang))
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
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
  // The escrow panel is a SHARED admin message — when one admin clicks
  // Refresh, the rebuilt panel must stay in the bot display language so
  // it doesn't switch to the clicker's preferred language for everyone.
  // Ephemeral replies still use the clicker's language (langFor).
  const lang = langFor(interaction);
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const sharedLang = getBotDisplayLanguage();

  // Admin only
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
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
}

module.exports = { postEscrowPanel, handleEscrowButton };
