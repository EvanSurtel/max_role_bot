// Shared utilities for queue match channels, permissions, and staff checks.
//
// These are low-level helpers imported by matchLifecycle, interactions, and
// subCommands. They depend only on state.js and external libs — never on
// other queue phase files.

const { PermissionFlagsBits } = require('discord.js');
const { waitingQueue } = require('./state');

/**
 * Build permission overwrites for queue match channels. All players
 * can view/send/connect/speak. Staff roles get visibility too.
 * @param {import('discord.js').Guild} guild — The Discord guild.
 * @param {string[]} playerDiscordIds — Discord IDs of all players.
 * @returns {Array<object>} Permission overwrite array for channel creation.
 */
function _queueChannelOverwrites(guild, playerDiscordIds) {
  const overwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    },
  ];

  for (const playerId of playerDiscordIds) {
    overwrites.push({
      id: playerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  // Staff visibility
  const staffRoles = [
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
  ].filter(Boolean);

  for (const roleId of staffRoles) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  return overwrites;
}

/**
 * Delete all channels and category for a queue match, then remove
 * the match from activeMatches.
 * @param {import('discord.js').Client} client — Discord client.
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function _cleanupMatchChannels(client, match) {
  const { activeMatches } = require('./state');
  const channelIds = [match.textChannelId, match.voiceChannelId].filter(Boolean);

  for (const channelId of channelIds) {
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Queue match cleanup');
      }
    } catch (err) {
      console.error(`[QueueService] Failed to delete channel ${channelId}:`, err.message);
    }
  }

  if (match.categoryId) {
    try {
      const category = client.channels.cache.get(match.categoryId);
      if (category && category.deletable) {
        await category.delete('Queue match cleanup');
      }
    } catch (err) {
      console.error(`[QueueService] Failed to delete category ${match.categoryId}:`, err.message);
    }
  }

  // Remove from activeMatches
  activeMatches.delete(match.categoryId);
  console.log(`[QueueService] Cleaned up channels for queue match #${match.id}`);
}

/**
 * Check if a guild member has staff/admin privileges.
 * @param {import('discord.js').GuildMember} member — The guild member.
 * @returns {boolean} True if the member has a staff role.
 */
function _isStaffMember(member) {
  const roles = member?.roles?.cache;
  if (!roles) return false;
  const staffIds = [
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
  ].filter(Boolean);
  return staffIds.some(id => roles.has(id));
}

/**
 * Find the player in the waiting queue with the closest XP to the target.
 * Removes them from the queue and returns their entry, or null.
 * @param {number} targetXp — Target XP to match against.
 * @returns {{ discordId: string, joinedAt: number, xp: number }|null}
 */
function findClosestXpReplacement(targetXp) {
  if (waitingQueue.length === 0) return null;

  // Filter out anyone who became busy in another system (wager/XP
  // match) since they joined the queue. This shouldn't happen if
  // the join checks are working, but belt-and-suspenders.
  const { isInActiveMatch } = require('./state');
  const userRepo = require('../database/repositories/userRepo');
  const eligible = [];
  for (let i = 0; i < waitingQueue.length; i++) {
    const entry = waitingQueue[i];
    if (isInActiveMatch(entry.discordId)) continue; // in another queue match
    const user = userRepo.findByDiscordId(entry.discordId);
    if (user) {
      const { isPlayerBusy } = require('../utils/playerStatus');
      const busy = isPlayerBusy(user.id, entry.discordId);
      if (busy.busy) continue; // in a wager/XP match
    }
    eligible.push({ index: i, ...entry });
  }

  if (eligible.length === 0) return null;

  let best = eligible[0];
  let bestDiff = Math.abs(best.xp - targetXp);

  for (let i = 1; i < eligible.length; i++) {
    const diff = Math.abs(eligible[i].xp - targetXp);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = eligible[i];
    }
  }

  // Remove from waitingQueue by original index
  return waitingQueue.splice(best.index, 1)[0];
}

module.exports = {
  _queueChannelOverwrites,
  _cleanupMatchChannels,
  _isStaffMember,
  findClosestXpReplacement,
};
