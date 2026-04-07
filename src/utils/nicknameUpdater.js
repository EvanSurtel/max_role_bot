const userRepo = require('../database/repositories/userRepo');
const { USDC_PER_UNIT } = require('../config/constants');

/**
 * Update a user's Discord nickname to show XP and earnings.
 * Format: DisplayName [XP] [$Earnings]
 * e.g. "Select [1510] [$25.50]"
 *
 * @param {import('discord.js').Client} client
 * @param {number} userId - Internal user ID
 */
async function updateNickname(client, userId) {
  try {
    const user = userRepo.findById(userId);
    if (!user) return;

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const member = await guild.members.fetch(user.discord_id).catch(() => null);
    if (!member) return;

    const displayName = user.server_username || member.user.username;
    const xp = user.xp_points || 0;
    const earnings = Number(user.total_earnings_usdc || 0) / USDC_PER_UNIT;

    let nickname = `${displayName} [${xp}]`;
    if (earnings > 0) {
      nickname += ` [$${earnings.toFixed(2)}]`;
    }

    // Discord nickname max is 32 chars — truncate display name if needed
    if (nickname.length > 32) {
      const statsLength = nickname.length - displayName.length;
      const maxName = 32 - statsLength;
      nickname = `${displayName.slice(0, maxName)} [${xp}]`;
      if (earnings > 0) nickname += ` [$${earnings.toFixed(2)}]`;
    }

    await member.setNickname(nickname).catch(err => {
      // Can't set nickname on server owner or higher-role users
      console.warn(`[Nickname] Could not update for ${user.discord_id}:`, err.message);
    });
  } catch (err) {
    console.error(`[Nickname] Error updating user ${userId}:`, err.message);
  }
}

/**
 * Update nicknames for multiple users at once.
 */
async function updateNicknames(client, userIds) {
  for (const userId of userIds) {
    await updateNickname(client, userId);
  }
}

module.exports = { updateNickname, updateNicknames };
