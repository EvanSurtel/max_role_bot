// /rank slash command.
//
// Usage:
//   /rank               → show your own rank
//   /rank user:@player  → show another player's rank
//
// Posts a public embed "trading card" with the player's season XP,
// W/L, leaderboard position, and their rank emblem rendered full-
// width. Colored by the rank tier.
//
// XP source of truth: NeatQueue's channel leaderboard. Falls back
// to local users.xp_points if NeatQueue is unreachable. Crowned is
// position-based (top N on the NeatQueue leaderboard).

const path = require('path');
const fs = require('fs');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { getLocale } = require('../locales');
const { langFor } = require('../locales/i18n');

const EMBLEM_DIR = path.join(__dirname, '..', 'public', 'assets', 'emblems');

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

// Same defensive shape handling as rankRoleSync — NeatQueue's
// leaderboard API response isn't pinned to a single shape in our
// code, so we probe a few common field names.
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show a player\'s rank, XP, and emblem')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('The player to look up (defaults to yourself)')
        .setRequired(false),
    ),

  async execute(interaction) {
    const lang = langFor(interaction);
    const tRanks = getLocale('ranks', lang);

    const target = interaction.options.getUser('user') || interaction.user;

    const user = userRepo.findByDiscordId(target.id);
    if (!user || !user.accepted_tos) {
      return interaction.reply({
        content: `<@${target.id}> hasn't registered with the bot yet.`,
        ephemeral: true,
      });
    }

    // Defer — the NeatQueue lookup might take a second or two
    await interaction.deferReply();

    // Fetch authoritative XP from NeatQueue
    let points = null;
    let position = null;
    try {
      if (neatqueueService.isConfigured()) {
        const raw = await neatqueueService.getChannelLeaderboard();
        const lb = _normalizeLeaderboard(raw);
        const idx = lb.findIndex(e => e.userId === String(target.id));
        if (idx !== -1) {
          points = lb[idx].points;
          position = idx + 1;
        }
      }
    } catch (err) {
      console.warn('[RankCmd] NeatQueue lookup failed, falling back to local:', err.message);
    }

    // Fall back to local xp_points if NeatQueue couldn't tell us
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

    // Display name: server nickname > IGN > Discord username
    const displayName = user.server_username || user.cod_ign || target.username;
    const flagPrefix = user.country_flag ? `${user.country_flag} ` : '';

    // Build the trading-card embed
    const embed = new EmbedBuilder()
      .setColor(tier.color)
      .setAuthor({ name: `${flagPrefix}${displayName}` })
      .setTitle(`🏆 ${rankName}`)
      .addFields(
        { name: 'Season XP', value: `**${points.toLocaleString('en-US')}**`, inline: true },
        { name: 'Record', value: `**${user.total_wins || 0}W – ${user.total_losses || 0}L**`, inline: true },
      );

    if (position !== null) {
      const medal = position === 1 ? '🥇' : position === 2 ? '🥈' : position === 3 ? '🥉' : `#${position}`;
      embed.addFields({ name: 'Leaderboard', value: `**${medal}**`, inline: true });
    }

    if (user.cod_ign) {
      embed.setFooter({ text: `IGN: ${user.cod_ign}` });
    }

    // Attach the tier emblem — full-width image at the bottom of the
    // embed, same size as in the ranks panel.
    const files = [];
    if (tier.emblem) {
      const emblemPath = path.join(EMBLEM_DIR, tier.emblem);
      if (fs.existsSync(emblemPath)) {
        files.push(new AttachmentBuilder(emblemPath, { name: tier.emblem }));
        embed.setImage(`attachment://${tier.emblem}`);
      }
    }

    return interaction.editReply({ embeds: [embed], files });
  },
};
