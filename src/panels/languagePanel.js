// Dedicated language channel panel — the master switch for the user's
// bot-wide language preference. Lives in its own channel (LANGUAGE_CHANNEL_ID)
// so users can change their language at any time without going back to the
// welcome panel.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');

/**
 * Build the dedicated language picker panel.
 *
 * @param {string} lang - the language to display the panel itself in
 */
function buildLanguagePanel(lang = 'en') {
  // The embed itself is rendered in the requested display language so users
  // can see the current state. The select menu options always show every
  // language in its native name (so a French user can find "Français" even
  // if the panel is currently rendered in English).
  const embed = new EmbedBuilder()
    .setTitle(t('language_panel.title', lang))
    .setColor(0x3498db)
    .setDescription(t('language_panel.description', lang))
    .setFooter({ text: t('language_panel.footer', lang) });

  const options = Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('language_panel_select')
      .setPlaceholder(t('language_panel.placeholder', lang))
      .addOptions(options),
  );

  return { embeds: [embed], components: [selectRow] };
}

/**
 * Post (or refresh) the dedicated language panel in LANGUAGE_CHANNEL_ID.
 */
async function postLanguagePanel(client, lang = 'en') {
  const channelId = process.env.LANGUAGE_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] LANGUAGE_CHANNEL_ID not set — skipping language panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Language channel ${channelId} not found in cache`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildLanguagePanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) { if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ } }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated existing language panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted new language panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post language panel:', err.message);
  }
}

module.exports = { buildLanguagePanel, postLanguagePanel };
