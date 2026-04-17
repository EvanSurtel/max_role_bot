// Channel cleanup + no-show reminders.
const matchRepo = require('../../database/repositories/matchRepo');
const { MATCH_STATUS } = require('../../config/constants');
const { t, getLang } = require('../../locales/i18n');
const { buildLanguageDropdownRow } = require('../../utils/languageButtonHelper');

/**
 * Clean up match channels after a match is completed or cancelled.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 */
async function cleanupChannels(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    console.error(`[MatchService] Match ${matchId} not found for cleanup`);
    return;
  }

  const channelIds = [
    match.team1_text_id,
    match.team1_voice_id,
    match.team2_text_id,
    match.team2_voice_id,
    match.shared_text_id,
    match.shared_voice_id,
    match.voting_channel_id,
  ];

  for (const channelId of channelIds) {
    if (!channelId) continue;
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete channel ${channelId}:`, err.message);
    }
  }

  if (match.category_id) {
    try {
      const category = client.channels.cache.get(match.category_id);
      if (category && category.deletable) {
        await category.delete('Match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete category ${match.category_id}:`, err.message);
    }
  }

  console.log(`[MatchService] Cleaned up channels for match #${matchId}`);
}

/**
 * Check which players are NOT in any of the match voice channels.
 *
 * @param {import('discord.js').Client} client
 * @param {object} match - DB match row.
 * @param {string[]} playerDiscordIds
 * @returns {string[]} Discord IDs of players not in voice.
 */
function getPlayersNotInVoice(client, match, playerDiscordIds) {
  const voiceChannelIds = [match.team1_voice_id, match.team2_voice_id, match.shared_voice_id].filter(Boolean);
  const inVoice = new Set();

  for (const vcId of voiceChannelIds) {
    const vc = client.channels.cache.get(vcId);
    if (vc && vc.members) {
      for (const [memberId] of vc.members) {
        inVoice.add(memberId);
      }
    }
  }

  return playerDiscordIds.filter(id => !inVoice.has(id));
}

/**
 * Start no-show reminder pings at 5min and 10min after match creation.
 * Checks if players have joined any match voice channel.
 *
 * @param {import('discord.js').Client} client
 * @param {object} match - DB match row.
 * @param {string[]} playerDiscordIds
 */
function startNoShowReminders(client, match, playerDiscordIds) {
  const sharedChannelId = match.shared_text_id;
  if (!sharedChannelId) return;

  const reminderLang = () => {
    const notInVoice = getPlayersNotInVoice(client, match, playerDiscordIds);
    return notInVoice.length > 0 ? getLang(notInVoice[0]) : 'en';
  };

  // 5 minute reminder
  setTimeout(async () => {
    try {
      const currentMatch = matchRepo.findById(match.id);
      if (!currentMatch || currentMatch.status !== MATCH_STATUS.ACTIVE) return;

      const notInVoice = getPlayersNotInVoice(client, currentMatch, playerDiscordIds);
      if (notInVoice.length === 0) return;

      const ch = client.channels.cache.get(sharedChannelId);
      if (ch) {
        const pings = notInVoice.map(id => `<@${id}>`).join(' ');
        const lang = reminderLang();
        await ch.send({ content: t('match_channel.no_show_warning_5', lang, { pings }), components: [...buildLanguageDropdownRow(lang)] });
      }
    } catch (err) {
      console.error(`[MatchService] No-show reminder (5min) failed:`, err.message);
    }
  }, 5 * 60 * 1000);

  // 10 minute reminder
  setTimeout(async () => {
    try {
      const currentMatch = matchRepo.findById(match.id);
      if (!currentMatch || currentMatch.status !== MATCH_STATUS.ACTIVE) return;

      const notInVoice = getPlayersNotInVoice(client, currentMatch, playerDiscordIds);
      if (notInVoice.length === 0) return;

      const ch = client.channels.cache.get(sharedChannelId);
      if (ch) {
        const pings = notInVoice.map(id => `<@${id}>`).join(' ');
        const lang = reminderLang();
        await ch.send({ content: t('match_channel.no_show_warning_10', lang, { pings }), components: [...buildLanguageDropdownRow(lang)] });
      }
    } catch (err) {
      console.error(`[MatchService] No-show reminder (10min) failed:`, err.message);
    }
  }, 10 * 60 * 1000);
}

module.exports = { cleanupChannels, getPlayersNotInVoice, startNoShowReminders };
