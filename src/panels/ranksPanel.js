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
  // Position-based tiers (e.g., "Top 10 players") use topN instead of
  // an XP threshold. Fall back to English if the locale hasn't added
  // the range_top key yet.
  if (tier.topN) {
    const tpl = t.range_top || 'Top {n} players';
    return tpl.replace('{n}', tier.topN);
  }
  // No next tier, OR the next tier is position-based (so this tier
  // effectively has no XP ceiling from a display standpoint)
  if (!nextTier || nextTier.topN) {
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
        // setImage() renders the emblem full-width at the bottom of
        // the embed — much larger than setThumbnail(), which just
        // sticks a small square in the corner.
        embed.setImage(`attachment://${tier.emblem}`);
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
    console.log('[Panel] Ranks: clearing old messages...');
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      // Bulk delete if possible (faster, handles up to 100 messages < 14 days old)
      try {
        await channel.bulkDelete(botMessages);
      } catch {
        // Fallback to individual delete for old messages
        for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      }
    }

    console.log('[Panel] Ranks: building panel...');
    const { embeds, files } = buildRanksPanel(lang);
    console.log(`[Panel] Ranks: ${embeds.length} embeds, ${files.length} files`);

    // Language dropdown
    console.log('[Panel] Ranks: sending language dropdown...');
    await channel.send({
      content: '🌐 Pick a language to view this in:',
      components: [buildLanguageDropdownRow(lang)],
    });

    // Send intro embed first
    console.log('[Panel] Ranks: sending intro...');
    await channel.send({ embeds: [embeds[0]] });

    // Send each rank as its own message
    for (let i = 1; i < embeds.length; i++) {
      const tier = RANK_TIERS[i - 1];
      const tierFile = files.find(f => f.name === tier.emblem);
      console.log(`[Panel] Ranks: sending ${tier.key} (file: ${tierFile ? tierFile.name : 'none'})...`);
      await channel.send({
        embeds: [embeds[i]],
        files: tierFile ? [tierFile] : [],
      });
    }

    const missing = RANK_TIERS.length - files.length;
    if (missing > 0) {
      console.log(`[Panel] Posted ranks panel (${lang}) — ${missing} emblem PNG(s) missing from src/assets/ranks/`);
    } else {
      console.log(`[Panel] Posted ranks panel (${lang}) with all ${RANK_TIERS.length} emblems`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post ranks panel:', err.message);
    if (err.code) console.error('[Panel] Discord error code:', err.code);
    if (err.rawError) console.error('[Panel] Raw error:', JSON.stringify(err.rawError));
  }
}

module.exports = { buildRanksPanel, postRanksPanel };
