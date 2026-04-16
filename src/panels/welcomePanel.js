const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

/**
 * Build the standalone language picker for the welcome channel.
 *
 * Posted as the FIRST message at the top of the welcome channel — a
 * minimal title + the dropdown, no long explanatory text. Each bot
 * channel has its own dropdown so the user doesn't need a paragraph
 * about "master switches" here.
 *
 * @param {string} lang - the language to render the picker itself in (unused
 *                        for the title since it's intentionally multi-language)
 */
function buildWelcomeLanguagePicker(_lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle('🌐 Language / Idioma / Idioma / Sprache / Langue / 言語 / 语言')
    .setColor(0x3498db);

  return { embeds: [embed], components: [...buildLanguageDropdownRow(_lang)] };
}

/**
 * Build the welcome/TOS panel — embeds + Accept/Decline buttons only.
 * The language picker is sent as a separate message above this one (see
 * `postWelcomePanel`), so users see it first when they enter the channel.
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

  // No dropdown here — the welcome channel has the dropdown at the TOP
  // (in buildWelcomeLanguagePicker), so users don't have to scroll past
  // the entire TOS to switch language.
  return {
    embeds: [welcomeEmbed, tos1Embed, tos2Embed, verifyEmbed],
    components: [actionRow],
  };
}

/**
 * Post (or refresh) the welcome channel.
 *
 * Sends TWO messages:
 *   1. Language picker (top of channel — posted first, oldest)
 *   2. Welcome panel + TOS + Accept/Decline (below — posted second)
 *
 * On startup we wipe any old bot messages first so we don't accumulate.
 */
async function postWelcomePanel(client, lang = 'en') {
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
    // Wipe any old bot messages — we always re-post fresh so the language
    // picker stays at the top (oldest message) and the welcome panel below.
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const [, m] of messages) {
      if (m.author.id === client.user.id) {
        try { await m.delete(); } catch { /* */ }
      }
    }

    // Post language picker FIRST (it'll be at the top of the channel)
    await channel.send(buildWelcomeLanguagePicker(lang));

    // Post welcome panel SECOND (it'll appear below the language picker)
    await channel.send(buildWelcomePanel(lang));

    console.log(`[Panel] Posted welcome panel + language picker (${lang})`);
  } catch (err) {
    console.error('[Panel] Failed to post welcome panel:', err.message);
  }
}

module.exports = { buildWelcomePanel, buildWelcomeLanguagePicker, postWelcomePanel };
