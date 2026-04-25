// Discord channel permission overwrite templates.
const { PermissionFlagsBits } = require('discord.js');

/**
 * Add staff roles (wager staff, XP staff, admin, owner, CEO, ads)
 * to permission overwrites so they can view and interact with
 * match/dispute channels. Owner, CEO, and ads roles have the same
 * access as admin everywhere in the bot.
 */
function addStaffOverwrites(overwrites) {
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
 * Build permission overwrites for a private text channel.
 * Denies @everyone ViewChannel, allows the bot and each specified user to View and Send.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string[]} allowedUserIds - Array of Discord user IDs.
 * @returns {object[]} Permission overwrites array for channel creation.
 */
function privateTextOverwrites(guild, allowedUserIds, includeStaff = false, adminOnly = false, readOnly = false) {
  // Non-participants can see the channel exists in the match category
  // (so the server looks active to other members) but can't read
  // history or send messages. See sharedOverwrites for full rationale.
  // Wallet/admin-only channels (adminOnly=true) keep the strict
  // ViewChannel deny — they contain user financial info.
  const everyoneRule = adminOnly
    ? { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }
    : {
      id: guild.id,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    };
  const overwrites = [
    everyoneRule,
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
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
  // Owner, CEO, and ads roles are treated as admin-equivalent.
  if (adminOnly) {
    const elevatedRoles = [
      process.env.ADMIN_ROLE_ID,
      process.env.OWNER_ROLE_ID,
      process.env.CEO_ROLE_ID,
      process.env.ADS_ROLE_ID,
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
  // Non-participants can SEE the voice channel and who's connected
  // (signals server activity to the rest of the guild) but can't
  // join or speak. See sharedOverwrites for full rationale.
  const overwrites = [
    {
      id: guild.id, // @everyone role
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ],
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
  // Non-participants can see the vote channel exists in the match
  // category (so the category renders for everyone) but can't read
  // captain reports or send messages.
  const overwrites = [
    {
      id: guild.id, // @everyone role
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
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
  // Used for BOTH the shared text channel and the shared voice
  // channel (createChannels.js calls this twice). We allow @everyone
  // ViewChannel so non-participants see the channel exists in the
  // match category — but deny all interactive perms (Connect, Speak,
  // SendMessages, ReadMessageHistory, AddReactions, etc).
  //
  // Why: the user wants the server to look ACTIVE — non-participants
  // see "Match #42" with people in voice and know matches are
  // happening. Discord ignores irrelevant permission bits per
  // channel type, so denying voice perms on the text channel and
  // text perms on the voice channel is harmless.
  //
  // Match content stays private: ReadMessageHistory deny on text =
  // outsiders can't read chat; Connect deny on voice = outsiders
  // can't snoop on the call.
  const overwrites = [
    {
      id: guild.id, // @everyone role
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
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
