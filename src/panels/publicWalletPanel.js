// Public wallet channel panel.
//
// The wallet channel is now a single SHARED public channel with one
// persistent panel. Every user sees the same panel message. When a user
// clicks "View My Wallet", the bot replies with an ephemeral containing
// THEIR wallet info (balance, address, action buttons) in their language.
// The ephemeral is private to that user.
//
// This replaces the old per-user wallet channel model, which didn't scale
// past ~300-400 users due to Discord's 500 channel cap per server.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

/**
 * Build the public wallet channel panel.
 *
 * @param {string} lang - bot display language (for the panel embed text and
 *                        default button labels). Individual users see their
 *                        wallet ephemeral in their own language.
 */
function buildPublicWalletPanel(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t('public_wallet.title', lang))
    .setColor(0x2ecc71)
    .setDescription(t('public_wallet.description', lang))
    .setFooter({ text: t('public_wallet.footer', lang) });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wallet_view_open')
      .setEmoji('👛')
      .setLabel(t('public_wallet.btn_view_wallet', lang))
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [actionRow, buildLanguageDropdownRow(lang)] };
}

/**
 * Post (or refresh) the public wallet panel in WALLET_CHANNEL_ID.
 * Edits the existing panel in place if one is found; otherwise posts fresh.
 */
async function postPublicWalletPanel(client, lang = 'en') {
  const channelId = process.env.WALLET_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WALLET_CHANNEL_ID not set — skipping public wallet panel');
    return;
  }

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[Panel] Could not fetch wallet channel ${channelId}:`, err.message);
      return;
    }
  }
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildPublicWalletPanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated public wallet panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted public wallet panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post public wallet panel:', err.message);
  }
}

module.exports = { buildPublicWalletPanel, postPublicWalletPanel };
