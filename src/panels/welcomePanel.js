const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

/**
 * Build the standalone language picker for the welcome channel.
 *
 * Posted as the FIRST message in the welcome channel so it sits at the top
 * — users see it immediately when they enter the channel and can pick their
 * language before reading the TOS below it.
 *
 * @param {string} lang - the language to render the picker itself in
 */
function buildWelcomeLanguagePicker(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle('🌐 Language / Idioma / Idioma / Sprache / Langue / 言語 / 语言')
    .setColor(0x3498db)
    .setDescription(t('language_panel.description', lang));

  const options = Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('welcome_lang_master')
      .setPlaceholder(t('onboarding.language_picker_placeholder', lang))
      .addOptions(options),
  );

  return { embeds: [embed], components: [selectRow] };
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

  return {
    embeds: [welcomeEmbed, tos1Embed, tos2Embed, verifyEmbed],
    components: [actionRow, buildLanguageDropdownRow(lang)],
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
