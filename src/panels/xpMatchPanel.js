const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageButton } = require('../utils/languageButtonHelper');

/**
 * Build the XP match panel.
 */
function buildXpMatchPanel(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t('xp_panel.title', lang))
    .setColor(0x3498db)
    .setDescription(t('xp_panel.description', lang))
    .setFooter({ text: t('xp_panel.footer', lang) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_xp')
      .setLabel(t('xp_panel.btn_create_xp', lang))
      .setStyle(ButtonStyle.Primary),
    buildLanguageButton(lang),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Post (or refresh) the XP match panel.
 */
async function postXpMatchPanel(client, lang = 'en') {
  const channelId = process.env.XP_MATCH_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] XP_MATCH_CHANNEL_ID not set — skipping XP match panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] XP match channel ${channelId} not found`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildXpMatchPanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) { if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ } }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated existing XP match panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted new XP match panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post XP match panel:', err.message);
  }
}

module.exports = { buildXpMatchPanel, postXpMatchPanel };
