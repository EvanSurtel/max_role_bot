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
 * Detect whether a bot message is the admin wallet viewer panel by
 * looking for the `admin_wallet_view_select` UserSelectMenu customId
 * in its components. This lets the admin wallet viewer coexist with
 * the escrow panel in the same admin wallet channel without either
 * one wiping the other on startup.
 */
function _isAdminWalletViewerPanel(message) {
  if (!message.components || message.components.length === 0) return false;
  for (const row of message.components) {
    const comps = row.components || row.toJSON?.().components || [];
    for (const c of comps) {
      const id = c.customId || c.custom_id || c.data?.custom_id;
      if (id === 'admin_wallet_view_select') return true;
    }
  }
  return false;
}

/**
 * Post (or refresh) the admin wallet viewer panel in
 * ADMIN_WALLET_VIEWER_CHANNEL_ID. This channel ALSO hosts the escrow
 * wallet panel — both coexist as separate messages identified by their
 * component customIds. The channel should be configured with admin-only
 * permissions on Discord — this code only enforces permissions on the
 * interaction, not on the channel itself.
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
    const messages = await channel.messages.fetch({ limit: 30 });
    const existingPanel = messages.find(
      m => m.author.id === client.user.id && _isAdminWalletViewerPanel(m),
    );
    const panel = buildAdminWalletViewerPanel(lang);

    if (existingPanel) {
      // Edit only the existing admin wallet viewer panel — leave other
      // bot messages (like the escrow panel) alone.
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated admin wallet viewer panel (${lang})`);
    } else {
      await channel.send(panel);
      console.log(`[Panel] Posted admin wallet viewer panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post admin wallet viewer panel:', err.message);
  }
}

module.exports = { buildAdminWalletViewerPanel, postAdminWalletViewerPanel };
