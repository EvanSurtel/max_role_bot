// Message-based prefix commands.
//
// Complements the slash command router in interactionCreate.js.
// Some commands read better as raw text the user types into chat
// (e.g. `/rank @player` showing a rank card). Slash commands would
// force a `player:@user` option label into the rendered message —
// this handler parses the text before Discord's slash command UI
// gets a chance to label it.
//
// Requires the Message Content gateway intent (enabled in
// src/index.js) AND the "Message Content Intent" toggle in the
// Discord Developer Portal for the bot application.
//
// Supported commands:
//   /rank              → your own rank card
//   /rank @player      → that player's rank card

const { buildRankCard } = require('../commands/rank');
const { langFor } = require('../locales/i18n');

// IMPORTANT: order matters — /rank-preview must be checked BEFORE
// /rank because /rank-preview also starts with "/rank" and would
// otherwise get caught by the /rank handler.
const PREVIEW_CMD = /^\/rank[-_]?preview\b/i;
const RANK_CMD    = /^\/rank\b/i;

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    try {
      // Ignore bots (including ourselves) and DMs
      if (message.author.bot) return;
      if (!message.guild) return;

      const content = (message.content || '').trim();
      if (!content) return;

      if (PREVIEW_CMD.test(content)) {
        return handleRankPreview(message);
      }

      if (RANK_CMD.test(content)) {
        return handleRankCommand(message);
      }

      // Drop in additional prefix-commands here as they're added.
    } catch (err) {
      console.error('[MessageCreate] Handler error:', err);
    }
  },
};

/**
 * /rank-preview — admin-only tool that renders sample cards for
 * every tier + a few Crowned position variants, so you can eyeball
 * the design without needing a real player to exist at each rank.
 *
 * Renders 10 cards in total (Discord attachment cap per message):
 *   7 base tiers (Bronze → Obsidian) at a mid-band XP value
 *   3 Crowned variants at leaderboard positions 1, 5, 10
 */
async function handleRankPreview(message) {
  // Gate to admin-equivalent roles only — otherwise anyone could
  // spam a 10-attachment preview into any channel.
  const roleEnvs = ['CEO_ROLE_ID', 'OWNER_ROLE_ID', 'ADMIN_ROLE_ID', 'ADS_ROLE_ID'];
  const roleIds = roleEnvs.map(k => process.env[k]).filter(Boolean);
  const hasAdminRole = roleIds.some(id => message.member?.roles?.cache?.has(id));
  if (!hasAdminRole) {
    return message.reply({
      content: 'This preview is admin-only.',
      allowedMentions: { repliedUser: false },
    });
  }

  try { await message.channel.sendTyping(); } catch { /* ignore */ }

  const { renderRankCard } = require('../utils/rankCardRenderer');
  const { RANK_TIERS } = require('../config/constants');
  const { AttachmentBuilder } = require('discord.js');
  const { getLocale } = require('../locales');

  const lang = langFor({ user: message.author, member: message.member });
  const tRanks = getLocale('ranks', lang);

  // Roughly mid-band XP value for each non-Crowned tier so the
  // "Season XP" stat looks plausible.
  const sampleXp = {
    bronze:   500,
    silver:   1750,
    gold:     3750,
    platinum: 5500,
    diamond:  6375,
    sentinel: 7125,
    obsidian: 10000,
  };

  const files = [];
  try {
    // Base tiers — 7 cards
    for (const tier of RANK_TIERS) {
      if (tier.topN) continue; // Crowned handled below
      const xp = sampleXp[tier.key] ?? 500;
      const rankName = (tRanks[tier.key] && tRanks[tier.key].name) || tier.key;
      const buf = await renderRankCard({
        displayName: 'Sample Player',
        ign: 'SampleIGN',
        points: xp,
        wins: 20,
        losses: 10,
        position: null,
        tier,
        rankName,
      });
      files.push(new AttachmentBuilder(buf, { name: `preview-${tier.key}.png` }));
    }

    // Crowned variants at 1st, 5th, 10th
    const crowned = RANK_TIERS.find(t => t.topN);
    if (crowned) {
      const rankName = (tRanks.crowned && tRanks.crowned.name) || 'Crowned';
      for (const pos of [1, 5, 10]) {
        const buf = await renderRankCard({
          displayName: 'Sample Player',
          ign: 'SampleIGN',
          points: 15000,
          wins: 50,
          losses: 8,
          position: pos,
          tier: crowned,
          rankName,
        });
        files.push(new AttachmentBuilder(buf, { name: `preview-crowned-${pos}.png` }));
      }
    }
  } catch (err) {
    console.error('[RankPreview] Render failed:', err);
    return message.reply({
      content: 'Preview render failed — check the bot logs.',
      allowedMentions: { repliedUser: false },
    });
  }

  if (files.length === 0) {
    return message.reply({
      content: 'No tiers configured to preview.',
      allowedMentions: { repliedUser: false },
    });
  }

  return message.reply({
    content: `**Rank card previews** — ${files.length} variants (base tiers + Crowned at #1/#5/#10)`,
    files,
    allowedMentions: { repliedUser: false },
  });
}

async function handleRankCommand(message) {
  // First mentioned user, or the sender if nobody was @'d
  const target = message.mentions.users.first() || message.author;
  const lang = langFor({ user: message.author, member: message.member, locale: message.guild?.preferredLocale });

  // Show "bot is typing" so the user sees something is happening
  // while we round-trip to NeatQueue.
  try { await message.channel.sendTyping(); } catch { /* ignore */ }

  const result = await buildRankCard(target, lang);
  if (result.kind === 'error') {
    return message.reply({
      content: result.content,
      allowedMentions: { repliedUser: false },
    });
  }
  return message.reply({
    embeds: result.embeds,
    files: result.files,
    allowedMentions: { repliedUser: false },
  });
}
