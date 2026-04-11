// /rank slash command + rank-card helper.
//
// Usage:
//   /rank player:@someone  → show that player's rank card
//
// You can also right-click any user in chat and pick "View Rank"
// (see rank-context.js) — both paths produce the exact same embed
// via buildRankCard().
//
// XP source of truth: NeatQueue's channel leaderboard. Falls back
// to local users.xp_points if NeatQueue is unreachable. Crowned is
// position-based (top N on the NeatQueue leaderboard).

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { getLocale } = require('../locales');
const { langFor } = require('../locales/i18n');
const { renderRankCard } = require('../utils/rankCardRenderer');

function _tierForXp(xp) {
  let match = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (tier.topN) continue;
    if (typeof tier.minXp === 'number' && tier.minXp <= xp) {
      match = tier;
    }
  }
  return match;
}

function _positionBasedTier() {
  return RANK_TIERS.find(t => t.topN) || null;
}

function _normalizeLeaderboard(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw)
    ? raw
    : (raw.leaderboard || raw.data || raw.players || raw.entries || []);
  if (!Array.isArray(arr)) return [];
  const normalized = arr.map(entry => {
    const userId = String(
      entry.user_id || entry.userId || entry.id || entry.discord_id || entry.discordId || ''
    );
    const points = Number(
      entry.points ?? entry.score ?? entry.stats?.points ?? entry.xp ?? 0
    );
    return { userId, points };
  }).filter(e => e.userId);
  normalized.sort((a, b) => b.points - a.points);
  return normalized;
}

/**
 * Build the trading-card embed + emblem attachment for a target
 * Discord user. Shared by the /rank slash command and the "View
 * Rank" user context menu so both paths produce identical cards.
 *
 * Returns { kind: 'card', embeds, files } on success, or
 * { kind: 'error', content } with a user-facing error message
 * (e.g. "not registered") — callers just spread the fields into
 * interaction.reply / editReply.
 */
async function buildRankCard(targetUser, lang = 'en') {
  const tRanks = getLocale('ranks', lang);
  const user = userRepo.findByDiscordId(targetUser.id);
  if (!user || !user.accepted_tos) {
    return {
      kind: 'error',
      content: `<@${targetUser.id}> hasn't registered with the bot yet.`,
    };
  }

  // Fetch authoritative XP from NeatQueue
  let points = null;
  let position = null;
  try {
    if (neatqueueService.isConfigured()) {
      const raw = await neatqueueService.getChannelLeaderboard();
      const lb = _normalizeLeaderboard(raw);
      const idx = lb.findIndex(e => e.userId === String(targetUser.id));
      if (idx !== -1) {
        points = lb[idx].points;
        position = idx + 1;
      }
    }
  } catch (err) {
    console.warn('[RankCmd] NeatQueue lookup failed, falling back to local:', err.message);
  }

  if (points === null) {
    points = user.xp_points || 0;
  }

  // Decide the tier — Crowned overrides base tier when in top N
  const crowned = _positionBasedTier();
  let tier = _tierForXp(points);
  if (crowned && position !== null && position <= (crowned.topN || 10)) {
    tier = crowned;
  }

  const tierLocaleEntry = tRanks[tier.key] || {};
  const rankName = tierLocaleEntry.name || tier.key.charAt(0).toUpperCase() + tier.key.slice(1);

  // Display name priority: server nickname > IGN > Discord username
  const displayName = user.server_username || user.cod_ign || targetUser.username;

  // Render a composited PNG rank card via canvas — big emblem,
  // prominent name, stats row, tier-colored background accent.
  // Delivered as a plain file attachment (no embed) so Discord
  // renders it at full inline width for max visual impact.
  try {
    const pngBuffer = await renderRankCard({
      displayName,
      ign: user.cod_ign || null,
      points,
      wins: user.total_wins || 0,
      losses: user.total_losses || 0,
      position,
      tier,
      rankName,
    });
    const attachment = new AttachmentBuilder(pngBuffer, { name: `rank-${user.discord_id}.png` });
    // Include the target user as a clickable mention in the message
    // content. `allowedMentions: { users: [] }` tells Discord to
    // render the mention pill (clickable → profile popup) without
    // actually sending them a ping — the caller still has to pass
    // this along on the final interaction.reply / message.reply.
    return {
      kind: 'card',
      content: `<@${targetUser.id}>`,
      embeds: [],
      files: [attachment],
      allowedMentions: { users: [] },
    };
  } catch (err) {
    console.error('[RankCmd] Card render failed:', err.message);
    return {
      kind: 'error',
      content: `Couldn't render <@${targetUser.id}>'s rank card right now. Try again in a moment.`,
    };
  }
}

module.exports = {
  buildRankCard,

  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show a player\'s rank, XP, and emblem')
    .addUserOption(opt =>
      opt.setName('player')
        .setDescription('The player to look up')
        .setRequired(true),
    ),

  async execute(interaction) {
    const target = interaction.options.getUser('player');
    const lang = langFor(interaction);

    await interaction.deferReply();
    const result = await buildRankCard(target, lang);

    if (result.kind === 'error') {
      return interaction.editReply({ content: result.content });
    }
    return interaction.editReply({
      content: result.content,
      embeds: result.embeds,
      files: result.files,
      allowedMentions: result.allowedMentions,
    });
  },
};
