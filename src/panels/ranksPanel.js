// Ranks display panel.
//
// Posts one message to RANKS_CHANNEL_ID showing all rank tiers in order,
// each as its own embed with the rank emblem as a thumbnail. The XP
// ranges are derived from RANK_TIERS in constants.js so adjusting the
// progression is a one-file change.
//
// Emblems live at src/assets/ranks/{rank}.png. If a PNG is missing, the
// panel still renders that rank's text — it just skips the thumbnail
// for that tier instead of crashing.

const path = require('path');
const fs = require('fs');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getLocale } = require('../locales');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');
const { RANK_TIERS } = require('../config/constants');

const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets', 'emblems');

function _rankRange(tier, nextTier, t) {
  if (!nextTier) {
    return t.range_open.replace('{min}', tier.minXp.toLocaleString('en-US'));
  }
  return t.range_band
    .replace('{min}', tier.minXp.toLocaleString('en-US'))
    .replace('{max}', (nextTier.minXp - 1).toLocaleString('en-US'));
}

/**
 * Build the intro embed + one embed per rank tier + the attachments
 * that back the emblem thumbnails. Returns null for missing emblem
 * files (the embed is still rendered without a thumbnail).
 *
 * @param {string} lang
 * @param {boolean} withThumbnails - whether to include emblem thumbnails
 *   (the public panel uses true; ephemeral language-switches use false
 *   to avoid re-uploading 8 PNGs per user click)
 */
function buildRanksPanel(lang = 'en', { withThumbnails = true } = {}) {
  const t = getLocale('ranks', lang);

  const introEmbed = new EmbedBuilder()
    .setTitle(t.intro.title)
    .setColor(0xf1c40f)
    .setDescription(t.intro.description);

  const embeds = [introEmbed];
  const files = [];

  for (let i = 0; i < RANK_TIERS.length; i++) {
    const tier = RANK_TIERS[i];
    const next = RANK_TIERS[i + 1];
    const locale = t[tier.key] || { name: tier.key, blurb: '' };

    const rangeText = _rankRange(tier, next, t);
    const titleLine = t.rank_title
      .replace('{name}', locale.name)
      .replace('{range}', rangeText);

    const embed = new EmbedBuilder()
      .setTitle(titleLine)
      .setColor(tier.color)
      .setDescription(locale.blurb);

    if (withThumbnails && tier.emblem) {
      const emblemPath = path.join(ASSETS_DIR, tier.emblem);
      if (fs.existsSync(emblemPath)) {
        files.push(new AttachmentBuilder(emblemPath, { name: tier.emblem }));
        embed.setThumbnail(`attachment://${tier.emblem}`);
      }
    }

    embeds.push(embed);
  }

  return { embeds, files };
}

/**
 * Post the ranks panel to RANKS_CHANNEL_ID. Clears any existing bot
 * messages in the channel first so the channel always shows a single
 * clean version of the panel.
 */
async function postRanksPanel(client, lang = 'en') {
  const channelId = process.env.RANKS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] RANKS_CHANNEL_ID not set — skipping ranks panel');
    return;
  }

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    try { channel = await client.channels.fetch(channelId); } catch { /* unreachable */ }
  }
  if (!channel) {
    console.error(`[Panel] RANKS_CHANNEL_ID=${channelId} unreachable`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const { embeds, files } = buildRanksPanel(lang);

    // Language dropdown as its OWN message at the top, matching the
    // rules / howItWorks channel layout.
    await channel.send({
      content: '🌐 Pick a language to view this in:',
      components: [buildLanguageDropdownRow(lang)],
    });

    // Intro + 8 rank embeds = 9 total — fits in a single message
    // (Discord allows up to 10 embeds per message).
    await channel.send({ embeds, files });

    const missing = RANK_TIERS.length - files.length;
    if (missing > 0) {
      console.log(`[Panel] Posted ranks panel (${lang}) — ${missing} emblem PNG(s) missing from src/assets/ranks/`);
    } else {
      console.log(`[Panel] Posted ranks panel (${lang}) with all ${RANK_TIERS.length} emblems`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post ranks panel:', err.message);
  }
}

module.exports = { buildRanksPanel, postRanksPanel };
