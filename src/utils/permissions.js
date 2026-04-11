const { PermissionFlagsBits } = require('discord.js');

/**
 * Add staff roles (wager staff, XP staff, admin, owner) to permission
 * overwrites so they can view and interact with match/dispute channels.
 * Owner role has the same access as admin everywhere in the bot.
 */
function addStaffOverwrites(overwrites) {
  const staffRoles = [
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
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
 * Build permission overwrites for a private text channel.
 * Denies @everyone ViewChannel, allows the bot and each specified user to View and Send.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string[]} allowedUserIds - Array of Discord user IDs.
 * @returns {object[]} Permission overwrites array for channel creation.
 */
function privateTextOverwrites(guild, allowedUserIds, includeStaff = false, adminOnly = false, readOnly = false) {
  const overwrites = [
    {
      id: guild.id, // @everyone role
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
  ];

  for (const userId of allowedUserIds) {
    if (readOnly) {
      overwrites.push({
        id: userId,
        allow: [PermissionFlagsBits.ViewChannel],
        deny: [PermissionFlagsBits.SendMessages],
      });
    } else {
      overwrites.push({
        id: userId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }
  }

  if (includeStaff) addStaffOverwrites(overwrites);

  // Admin-only access (for wallet channels — staff cannot see these).
  // Owner role is treated as admin-equivalent and gets the same access.
  if (adminOnly) {
    const elevatedRoles = [
      process.env.ADMIN_ROLE_ID,
      process.env.OWNER_ROLE_ID,
    ].filter(Boolean);
    for (const roleId of elevatedRoles) {
      overwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      });
    }
  }

  return overwrites;
}

/**
 * Build permission overwrites for a private voice channel.
 * Denies @everyone ViewChannel, allows the bot and each specified user to View, Connect, and Speak.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string[]} allowedUserIds - Array of Discord user IDs.
 * @returns {object[]} Permission overwrites array for channel creation.
 */
function privateVoiceOverwrites(guild, allowedUserIds, includeStaff = false) {
  const overwrites = [
    {
      id: guild.id, // @everyone role
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    },
  ];

  for (const userId of allowedUserIds) {
    overwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  if (includeStaff) addStaffOverwrites(overwrites);
  return overwrites;
}

/**
 * Build permission overwrites for a voting channel.
 * Denies @everyone all. Captains can view only (no send). Bot can view and send.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string[]} captainIds - Discord user IDs of team captains.
 * @returns {object[]} Permission overwrites array for channel creation.
 */
function votingChannelOverwrites(guild, captainIds) {
  const overwrites = [
    {
      id: guild.id, // @everyone role
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
    {
      id: guild.client.user.id, // bot
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
  ];

  for (const captainId of captainIds) {
    overwrites.push({
      id: captainId,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }

  return overwrites;
}

/**
 * Build permission overwrites for a shared channel (both teams).
 * Denies @everyone ViewChannel. Allows all players to View, Connect, Speak, and Send.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string[]} allPlayerIds - Discord user IDs of all players from both teams.
 * @returns {object[]} Permission overwrites array for channel creation.
 */
function sharedOverwrites(guild, allPlayerIds) {
  const overwrites = [
    {
      id: guild.id, // @everyone role
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

  for (const playerId of allPlayerIds) {
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

  return overwrites;
}

module.exports = {
  privateTextOverwrites,
  privateVoiceOverwrites,
  votingChannelOverwrites,
  sharedOverwrites,
};
