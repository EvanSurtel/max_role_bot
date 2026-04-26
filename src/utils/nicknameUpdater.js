// Discord nickname sync — [Flag] Name [XP] [$Earnings] format.
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
    if (!user) {
      console.warn(`[Nickname] User id=${userId} not found in DB`);
      return;
    }

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) {
      console.warn(`[Nickname] Guild ${process.env.GUILD_ID} not in cache`);
      return;
    }

    const member = await guild.members.fetch(user.discord_id).catch(err => {
      console.warn(`[Nickname] Could not fetch member ${user.discord_id}: ${err.message}`);
      return null;
    });
    if (!member) return;

    const flag = user.country_flag || '';
    const displayName = user.server_username || member.user.username;
    const xp = user.xp_points || 0;
    const earnings = Number(user.total_earnings_usdc || 0) / USDC_PER_UNIT;

    // Format: Name 🇺🇸 [XP] [$Earnings] — earnings shown as $0.00 even
    // for users who've never played a cash match, so the nickname is
    // visually consistent across the leaderboard (no "some have $, some
    // don't" mismatch).
    const flagPart = flag ? ` ${flag}` : '';
    const statsPart = ` [${xp}] [$${earnings.toFixed(2)}]`;
    let nickname = `${displayName}${flagPart}${statsPart}`;

    // Discord nickname max is 32 chars — truncate display name if needed
    if (nickname.length > 32) {
      const maxName = 32 - flagPart.length - statsPart.length;
      nickname = `${displayName.slice(0, Math.max(1, maxName))}${flagPart}${statsPart}`;
    }

    // Skip no-op writes — Discord counts setNickname against the per-
    // guild rate limit even if the value didn't change.
    if (member.nickname === nickname) return;

    // Detect the most common reason setNickname silently fails: the
    // target member has a role equal to or higher than the bot's top
    // role, OR is the server owner. Discord rejects these with
    // "Missing Permissions" which looks like a generic failure in the
    // logs. Pre-check so we log a clear, actionable message.
    const botMember = guild.members.me;
    if (member.id === guild.ownerId) {
      console.warn(`[Nickname] Cannot update ${user.discord_id} — they are the server owner (Discord API forbids bots changing owner nicknames). Current nick stuck at: "${member.nickname || member.user.username}"`);
      return;
    }
    if (botMember && member.roles.highest.position >= botMember.roles.highest.position) {
      console.warn(`[Nickname] Cannot update ${user.discord_id} (${displayName}) — their highest role position (${member.roles.highest.name}/${member.roles.highest.position}) is >= bot's highest role (${botMember.roles.highest.name}/${botMember.roles.highest.position}). Move the bot's role ABOVE the user's rank/admin roles in Server Settings → Roles. Current nick stuck at: "${member.nickname || member.user.username}"`);
      return;
    }

    try {
      await member.setNickname(nickname);
      console.log(`[Nickname] Updated ${user.discord_id} (${displayName}) → "${nickname}"`);
    } catch (err) {
      // Generic fallback if the hierarchy check missed something —
      // e.g. the bot role is missing the Manage Nicknames permission.
      console.warn(`[Nickname] setNickname failed for ${user.discord_id} (${displayName}) → "${nickname}": ${err.message} (code=${err.code || 'n/a'}). Check bot has Manage Nicknames permission AND its role is above the user's role.`);
    }
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
