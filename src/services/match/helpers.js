// Shared utilities for match service modules.
const { getLang } = require('../../locales/i18n');

/**
 * Pick the language of the first captain found. Falls back to English
 * if no captain or no preference saved. Used for shared match channel
 * messages.
 *
 * @param {string[]} captainDiscordIds - Array of captain Discord IDs.
 * @returns {string} Locale code.
 */
function captainLang(captainDiscordIds) {
  if (!captainDiscordIds || captainDiscordIds.length === 0) return 'en';
  return getLang(captainDiscordIds[0]);
}

/**
 * Post a result embed to the regular results channels (all-results +
 * cash-match-results). Used by both the normal resolve flow AND the admin
 * dispute-resolution flow so dispute outcomes still appear in the feed.
 *
 * Tries the channel cache first and falls back to channels.fetch().
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').EmbedBuilder} resultEmbed
 * @param {Array} components - Message component rows.
 * @param {boolean} isCashMatch
 * @param {number} matchId
 */
async function postResultToChannels(client, resultEmbed, components, isCashMatch, matchId) {
  async function _resolve(channelId) {
    let ch = client.channels.cache.get(channelId);
    if (!ch) {
      try { ch = await client.channels.fetch(channelId); } catch { ch = null; }
    }
    return ch;
  }

  const allResultsChannelId = process.env.RESULTS_CHANNEL_ID;
  if (allResultsChannelId) {
    try {
      const ch = await _resolve(allResultsChannelId);
      if (ch) await ch.send({ embeds: [resultEmbed], components: components || [] });
      else console.error(`[MatchService] all-results channel ${allResultsChannelId} unreachable for match #${matchId}`);
    } catch (err) {
      console.error(`[MatchService] Failed to post to all-results for match #${matchId}:`, err.message);
    }
  }

  if (isCashMatch) {
    const wagerResultsChannelId = process.env.WAGER_RESULTS_CHANNEL_ID;
    if (wagerResultsChannelId) {
      try {
        const ch = await _resolve(wagerResultsChannelId);
        if (ch) await ch.send({ embeds: [resultEmbed], components: components || [] });
        else console.error(`[MatchService] cash-match-results channel ${wagerResultsChannelId} unreachable for match #${matchId}`);
      } catch (err) {
        console.error(`[MatchService] Failed to post to cash-match-results for match #${matchId}:`, err.message);
      }
    }
  }
}

/**
 * Award XP, stats, and earnings to winners and losers. Logs to xp_history.
 *
 * @param {object} params
 * @param {number} params.matchId
 * @param {object} params.challenge - DB challenge row.
 * @param {Array} params.winningPlayers - Winner challenge_player rows.
 * @param {Array} params.losingPlayers - Loser challenge_player rows.
 * @param {boolean} params.isCashMatch
 * @returns {{ winXp: number, loseXp: number, perPlayerEarnings: string }}
 */
function awardStats({ matchId, challenge, winningPlayers, losingPlayers, isCashMatch }) {
  const userRepo = require('../../database/repositories/userRepo');
  const { calculateXpMatchRewards, calculateWagerXpRewards } = require('../../utils/xpCalculator');
  const { getCurrentSeason } = require('../../panels/leaderboardPanel');
  const db = require('../../database/db');

  let winXp, loseXp;
  if (isCashMatch) {
    const rewards = calculateWagerXpRewards(challenge.entry_amount_usdc);
    winXp = rewards.winXp;
    loseXp = rewards.loseXp;
  } else {
    const winnerXpTotal = winningPlayers.reduce((sum, p) => {
      const u = userRepo.findById(p.user_id);
      return sum + (u ? u.xp_points : 0);
    }, 0);
    const loserXpTotal = losingPlayers.reduce((sum, p) => {
      const u = userRepo.findById(p.user_id);
      return sum + (u ? u.xp_points : 0);
    }, 0);
    const winnerAvg = winningPlayers.length > 0 ? winnerXpTotal / winningPlayers.length : 0;
    const loserAvg = losingPlayers.length > 0 ? loserXpTotal / losingPlayers.length : 0;
    const rewards = calculateXpMatchRewards(winnerAvg, loserAvg);
    winXp = rewards.winXp;
    loseXp = rewards.loseXp;
  }

  let perPlayerEarnings = '0';
  if (isCashMatch) {
    const matchPrize = BigInt(challenge.total_pot_usdc);
    const winnerCount = BigInt(winningPlayers.length);
    const entryAmount = BigInt(challenge.entry_amount_usdc);
    const share = matchPrize / winnerCount;
    perPlayerEarnings = (share - entryAmount).toString();
  }

  const insertXpHistory = db.prepare(
    'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
  );

  // Per-player atomic wrap so a mid-loop failure (constraint violation,
  // disk full, etc.) can't leave a player with e.g. XP awarded but no
  // win recorded + no xp_history row — which would desync the
  // xp_points column from the leaderboard (which reads xp_history).
  const awardWinnerTx = db.transaction((userId) => {
    userRepo.addXp(userId, winXp);
    userRepo.addWin(userId);
    insertXpHistory.run(userId, matchId, challenge.type, winXp, getCurrentSeason());
    if (isCashMatch) {
      userRepo.addEarnings(userId, perPlayerEarnings);
      userRepo.addEntered(userId, challenge.entry_amount_usdc);
      userRepo.incrementCashWin(userId);
    }
  });
  const awardLoserTx = db.transaction((userId) => {
    if (loseXp > 0) {
      userRepo.addXp(userId, -loseXp);
      insertXpHistory.run(userId, matchId, challenge.type, -loseXp, getCurrentSeason());
    }
    userRepo.addLoss(userId);
    if (isCashMatch) {
      userRepo.addEntered(userId, challenge.entry_amount_usdc);
      userRepo.incrementCashLoss(userId);
    }
  });

  for (const player of winningPlayers) {
    try {
      awardWinnerTx(player.user_id);
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for winner ${player.user_id}:`, err.message);
    }
  }

  for (const player of losingPlayers) {
    try {
      awardLoserTx(player.user_id);
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for loser ${player.user_id}:`, err.message);
    }
  }

  return { winXp, loseXp, perPlayerEarnings };
}

module.exports = { captainLang, postResultToChannels, awardStats };
