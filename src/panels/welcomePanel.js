// Welcome channel — TOS display + Accept/Decline buttons + language picker.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

// Discord limits:
//   - 4096 chars max per embed description
//   - 6000 chars total across all embeds in a single message
// We keep messages well under 6000 (5500 cap with headroom) and split
// the TOS across multiple messages when it doesn't fit.
const DISCORD_MESSAGE_CHAR_CAP = 5500;

function _embedChars(embed) {
  return (embed.data.title || '').length + (embed.data.description || '').length;
}

/**
 * Greedily pack embeds into the minimum number of messages such that each
 * message stays under DISCORD_MESSAGE_CHAR_CAP. Returns array of arrays.
 */
function _packEmbeds(embeds) {
  const groups = [];
  let current = [];
  let currentChars = 0;
  for (const e of embeds) {
    const ec = _embedChars(e);
    if (current.length > 0 && currentChars + ec > DISCORD_MESSAGE_CHAR_CAP) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(e);
    currentChars += ec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Build the standalone language picker for the welcome channel.
 *
 * Posted as the FIRST message at the top of the welcome channel — a
 * minimal title + the dropdown, no long explanatory text.
 */
function buildWelcomeLanguagePicker(_lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle('🌐 Language / Idioma / Idioma / Sprache / Langue / 言語 / 语言')
    .setColor(0x3498db);

  return { embeds: [embed], components: [...buildLanguageDropdownRow(_lang)] };
}

/**
 * Build all the embeds for the welcome / TOS / verify panel. The TOS
 * is split into up to 4 sections (tos_body, tos_body_2, tos_body_3,
 * tos_body_4) since the full document exceeds the 4096-char per-embed
 * limit. Older locales without _3 / _4 keys just skip those embeds.
 */
function _buildAllEmbeds(lang = 'en') {
  const embeds = [];

  embeds.push(new EmbedBuilder()
    .setTitle(t('onboarding.welcome_title', lang))
    .setColor(0x3498db)
    .setDescription(t('onboarding.welcome_desc', lang)));

  // TOS title goes only on the first TOS embed; subsequent TOS chunks
  // continue without title so they read as one document.
  embeds.push(new EmbedBuilder()
    .setTitle(t('onboarding.tos_title', lang))
    .setColor(0x3498db)
    .setDescription(t('onboarding.tos_body', lang)));

  // TOS continuation chunks. For locales where these keys haven't been
  // translated yet, t() falls back to English — so non-English users
  // see the first chunk in their language and the rest in English
  // (better than missing the legal sections entirely). Translations
  // catch up over time.
  for (const key of ['tos_body_2', 'tos_body_3', 'tos_body_4']) {
    const val = t('onboarding.' + key, lang);
    // t() returns the literal key string only if the key exists in
    // NEITHER the requested locale nor English. Defensive guard so we
    // don't push a useless "onboarding.tos_body_3" embed if someone
    // accidentally removes the English entry.
    if (val && val !== 'onboarding.' + key) {
      embeds.push(new EmbedBuilder()
        .setColor(0x3498db)
        .setDescription(val));
    }
  }

  embeds.push(new EmbedBuilder()
    .setTitle(t('onboarding.verify_title', lang))
    .setColor(0x2ecc71)
    .setDescription(t('onboarding.verify_desc', lang)));

  return embeds;
}

function _buildAcceptDeclineRow(lang = 'en') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel(t('onboarding.btn_accept', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel(t('onboarding.btn_decline', lang))
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Build the welcome/TOS panel as a SINGLE-MESSAGE shape (legacy callers).
 * Returns { embeds, components } with all embeds packed together.
 *
 * NOTE: With the longer TOS this WILL exceed Discord's 6000 chars per
 * message limit and Discord will reject the message. Use postWelcomePanel
 * which packs across multiple messages instead. Kept for back-compat.
 */
function buildWelcomePanel(lang = 'en') {
  return {
    embeds: _buildAllEmbeds(lang),
    components: [_buildAcceptDeclineRow(lang)],
  };
}

/**
 * Post (or refresh) the welcome channel.
 *
 * Sends:
 *   1. Language picker (top of channel — oldest message)
 *   2. One or more welcome / TOS messages, packed under the per-message
 *      char cap. Accept/Decline buttons attach to the LAST message so
 *      users see them at the bottom after reading the full TOS.
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
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);

    // Idempotency: if a bot message in this channel already has the
    // tos_accept button, the welcome panel is intact — every restart
    // re-posting was creating dozens of duplicate messages over time.
    // Only re-post if the panel is missing or visibly broken.
    const hasAcceptButton = botMessages.some(m => {
      for (const row of m.components || []) {
        for (const comp of row.components || []) {
          if (comp.customId === 'tos_accept') return true;
        }
      }
      return false;
    });
    if (hasAcceptButton) {
      console.log('[Panel] Welcome panel already present — skipping re-post');
      return;
    }

    // No intact panel found — wipe any stragglers and post fresh.
    for (const [, m] of botMessages) {
      try { await m.delete(); } catch { /* */ }
    }

    // 1) Language picker at the top
    await channel.send(buildWelcomeLanguagePicker(lang));

    // 2) Welcome / TOS / verify, packed into messages under Discord's
    //    6000-char per-message limit. The TOS document is now too long
    //    to fit in a single message.
    const allEmbeds = _buildAllEmbeds(lang);
    const groups = _packEmbeds(allEmbeds);
    const acceptRow = _buildAcceptDeclineRow(lang);

    for (let i = 0; i < groups.length; i++) {
      const isLast = i === groups.length - 1;
      const payload = { embeds: groups[i] };
      if (isLast) payload.components = [acceptRow];
      await channel.send(payload);
    }

    console.log(`[Panel] Posted welcome panel + language picker (${lang}, ${groups.length} TOS message(s))`);
  } catch (err) {
    console.error('[Panel] Failed to post welcome panel:', err.message);
  }
}

module.exports = { buildWelcomePanel, buildWelcomeLanguagePicker, postWelcomePanel };
