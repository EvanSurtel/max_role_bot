// Admin wallet viewer panel.
//
// Lives in a private admin-only channel (ADMIN_WALLET_VIEWER_CHANNEL_ID).
// Contains a UserSelectMenu so an admin can pick any server member and
// see that user's wallet (balance, address, transaction history) as an
// ephemeral. The selected user does NOT see this — only the admin who
// picked them.
//
// This is the admin equivalent of a regular user clicking "View My Wallet"
// in the public wallet channel — same data, but for any user, restricted
// to admins.

const {
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
} = require('discord.js');
const { t } = require('../locales/i18n');

/**
 * Build the admin wallet viewer panel (the persistent channel message
 * with the user select menu).
 */
function buildAdminWalletViewerPanel(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t('admin_wallet_viewer.title', lang))
    .setColor(0xe67e22)
    .setDescription(t('admin_wallet_viewer.description', lang))
    .setFooter({ text: t('admin_wallet_viewer.footer', lang) });

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('admin_wallet_view_select')
      .setPlaceholder(t('admin_wallet_viewer.placeholder', lang))
      .setMinValues(1)
      .setMaxValues(1),
  );

  return { embeds: [embed], components: [selectRow] };
}

/**
 * Post (or refresh) the admin wallet viewer panel in
 * ADMIN_WALLET_VIEWER_CHANNEL_ID. The channel itself should be
 * configured with admin-only permissions on Discord — this code does
 * not enforce permissions on the channel, only on the interaction.
 */
async function postAdminWalletViewerPanel(client, lang = 'en') {
  const channelId = process.env.ADMIN_WALLET_VIEWER_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] ADMIN_WALLET_VIEWER_CHANNEL_ID not set — skipping admin wallet viewer');
    return;
  }

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.error(`[Panel] Could not fetch admin wallet viewer channel ${channelId}:`, err.message);
      return;
    }
  }
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildAdminWalletViewerPanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated admin wallet viewer panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted admin wallet viewer panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post admin wallet viewer panel:', err.message);
  }
}

module.exports = { buildAdminWalletViewerPanel, postAdminWalletViewerPanel };
