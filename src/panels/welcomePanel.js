const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');

/**
 * Build the welcome/TOS panel for the static welcome channel.
 * The panel renders entirely in the requested language, including the
 * full Terms of Service body. This is the bot's MASTER language switch
 * — picking a language here saves it as the user's preference for the
 * entire bot.
 */
function buildWelcomePanel(lang = 'en') {
  const welcomeEmbed = new EmbedBuilder()
    .setTitle(t('onboarding.welcome_title', lang))
    .setColor(0x3498db)
    .setDescription(t('onboarding.welcome_desc', lang));

  // TOS sections 1-5
  const tos1Embed = new EmbedBuilder()
    .setTitle(t('onboarding.tos_title', lang))
    .setColor(0x3498db)
    .setDescription(t('onboarding.tos_body', lang));

  // TOS sections 6-9
  const tos2Embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setDescription(t('onboarding.tos_body_2', lang));

  const verifyEmbed = new EmbedBuilder()
    .setTitle(t('onboarding.verify_title', lang))
    .setColor(0x2ecc71)
    .setDescription(t('onboarding.verify_desc', lang));

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel(t('onboarding.btn_accept', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel(t('onboarding.btn_decline', lang))
      .setStyle(ButtonStyle.Danger),
  );

  // Master language picker — StringSelectMenu showing ALL 20 languages.
  // Picking a language here saves it as the user's preference for the
  // entire bot, not just this panel.
  const langOptions = Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  const langRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('welcome_lang_master')
      .setPlaceholder(t('onboarding.language_picker_placeholder', lang))
      .addOptions(langOptions),
  );

  return {
    embeds: [welcomeEmbed, tos1Embed, tos2Embed, verifyEmbed],
    components: [actionRow, langRow],
  };
}

/**
 * Post (or refresh) the welcome panel in the static welcome channel.
 */
async function postWelcomePanel(client) {
  const channelId = process.env.WELCOME_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WELCOME_CHANNEL_ID not set — skipping welcome panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Welcome channel ${channelId} not found`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);

    // Find existing welcome panel (if any)
    const existingPanel = botMessages.find(
      m => m.embeds.length > 0 && (m.embeds[0]?.title?.includes('Rank $') || m.embeds[0]?.title?.includes('Welcome')),
    );

    const panel = buildWelcomePanel();

    if (existingPanel) {
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) {
          try { await m.delete(); } catch { /* */ }
        }
      }
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing welcome panel');
    } else {
      for (const [, m] of botMessages) {
        try { await m.delete(); } catch { /* */ }
      }
      await channel.send(panel);
      console.log('[Panel] Posted new welcome panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post welcome panel:', err.message);
  }
}

module.exports = { buildWelcomePanel, postWelcomePanel };
