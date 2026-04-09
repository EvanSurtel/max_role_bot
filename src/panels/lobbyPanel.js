const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageButton } = require('../utils/languageButtonHelper');

/**
 * Build the main lobby panel — wager creation only.
 * The panel renders in the requested language and includes a Language
 * button so any user can switch their personal language from here.
 */
function buildLobbyPanel(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t('lobby.title', lang))
    .setColor(0xf1c40f)
    .setDescription(t('lobby.description', lang))
    .setFooter({ text: t('lobby.footer', lang) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_wager')
      .setLabel(t('lobby.btn_create_wager', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('create_dispute')
      .setLabel(t('lobby.btn_create_dispute', lang))
      .setStyle(ButtonStyle.Danger),
    buildLanguageButton(lang),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Post (or refresh) the lobby panel in the configured wager channel.
 */
async function postLobbyPanel(client, lang = 'en') {
  const channelId = process.env.WAGER_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WAGER_CHANNEL_ID not set — skipping lobby panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Wager channel ${channelId} not found in cache`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildLobbyPanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) { if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ } }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated existing lobby panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted new lobby panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post lobby panel:', err.message);
  }
}

module.exports = { buildLobbyPanel, postLobbyPanel };
