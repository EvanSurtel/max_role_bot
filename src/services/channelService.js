const { ChannelType } = require('discord.js');
const { privateTextOverwrites, privateVoiceOverwrites } = require('../utils/permissions');

/**
 * Create a private text channel visible only to the specified users and the bot.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string} name - Channel name.
 * @param {string[]} allowedUsers - Array of Discord user IDs allowed to view the channel.
 * @param {string} [categoryId] - Optional parent category ID.
 * @returns {Promise<import('discord.js').TextChannel>}
 */
async function createPrivateChannel(guild, name, allowedUsers, categoryId) {
  const overwrites = privateTextOverwrites(guild, allowedUsers);

  const options = {
    name,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: 'Wager bot private channel',
  };

  if (categoryId) {
    options.parent = categoryId;
  }

  return guild.channels.create(options);
}

/**
 * Create a private voice channel visible only to the specified users and the bot.
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {string} categoryId - Parent category ID.
 * @param {string} name - Channel name.
 * @param {string[]} allowedUsers - Array of Discord user IDs allowed to connect.
 * @returns {Promise<import('discord.js').VoiceChannel>}
 */
async function createVoiceChannel(guild, categoryId, name, allowedUsers) {
  const overwrites = privateVoiceOverwrites(guild, allowedUsers);

  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: categoryId,
    permissionOverwrites: overwrites,
    reason: 'Wager bot voice channel',
  });
}

/**
 * Safely delete a channel.
 * @param {import('discord.js').GuildChannel} channel - The channel to delete.
 */
async function deleteChannel(channel) {
  try {
    if (channel && channel.deletable) {
      await channel.delete('Wager bot cleanup');
    }
  } catch (err) {
    console.error(`[ChannelService] Failed to delete channel ${channel?.id}:`, err.message || err);
  }
}

module.exports = { createPrivateChannel, createVoiceChannel, deleteChannel };
