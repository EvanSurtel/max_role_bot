// Challenge lifecycle — teammate notification, board posting, cancellation.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../base/escrowManager');
const channelService = require('./channelService');
const timerService = require('./timerService');
const { challengeEmbed, formatUsdc } = require('../utils/embeds');
const { CHALLENGE_STATUS, PLAYER_STATUS, TIMERS, GAME_MODES, CHALLENGE_TYPE } = require('../config/constants');
const { t, getLang } = require('../locales/i18n');

// Track active teammate-accept timers so they can be cleared on cancel
const teammateTimers = new Map(); // `${challengeId}_${playerId}` -> timeout handle

/**
 * Notify each pending teammate about a challenge invitation.
 *
 * Strategy: try DM first (so we don't burn through Discord's 500
 * channels-per-guild limit on transient invite channels). If the
 * teammate has DMs disabled or the send fails for any reason, fall
 * back to creating a private `invite-{username}` channel they can
 * see.
 *
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {object} challenge - The challenge DB record.
 */
async function notifyTeammates(guild, challenge) {
  const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
  const pendingPlayers = players.filter(p => p.status === PLAYER_STATUS.PENDING);

  for (const player of pendingPlayers) {
    try {
      const user = userRepo.findById(player.user_id);
      if (!user) {
        console.error(`[ChallengeService] No user found for player ${player.user_id}`);
        continue;
      }

      const discordId = user.discord_id;

      // Build challenge details embed in the CREATOR's language.
      // If a creator makes a challenge in Spanish, their teammates are
      // likely Spanish-speaking too, so use the creator's preference.
      const creatorUser = userRepo.findById(challenge.creator_user_id);
      const lang = creatorUser ? getLang(creatorUser.discord_id) : getLang(discordId);
      const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
      const modeInfo = GAME_MODES[challenge.game_modes];
      const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

      const creatorMention = creatorUser ? `<@${creatorUser.discord_id}>` : 'Unknown';
      const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
      const displayNum = challenge.display_number || challenge.id;

      const description = [
        t('notify_team.description', lang, { creator: creatorMention }),
        '',
        `**${t('notify_team.field_type', lang)}:** ${typeLabel}`,
        `**${t('notify_team.field_team_size', lang)}:** ${challenge.team_size}v${challenge.team_size}`,
        `**${t('notify_team.field_mode', lang)}:** ${modeLabel}`,
        `**${t('notify_team.field_series', lang)}:** ${t('challenge_create.series_label', lang, { n: challenge.series_length })}`,
      ];

      if (isCashMatch) {
        const entryAmount = (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2);
        description.push(`**${t('notify_team.field_entry', lang)}:** ${t('notify_team.entry_per_player', lang, { amount: entryAmount })}`);
      }

      description.push('', t('notify_team.accept_window', lang, { minutes: TIMERS.TEAMMATE_ACCEPT / 60000 }));

      // Build buttons in the recipient's language
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`teammate_accept_${challenge.id}`)
          .setLabel(t('notify_team.btn_accept', lang))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`teammate_decline_${challenge.id}`)
          .setLabel(t('notify_team.btn_decline', lang))
          .setStyle(ButtonStyle.Danger),
      );

      const embedPayload = {
        title: t('notify_team.title', lang, { type: typeLabel, num: displayNum }),
        description: description.join('\n'),
        color: isCashMatch ? 0xf1c40f : 0x3498db,
      };

      // ── Try DM first ────────────────────────────────────────────
      let dmUser = null;
      let fallbackChannel = null;
      try {
        dmUser = await guild.client.users.fetch(discordId);
        await dmUser.send({ embeds: [embedPayload], components: [row] });
        console.log(`[ChallengeService] DM'd teammate ${discordId} for challenge ${challenge.id}`);
      } catch (dmErr) {
        // DMs disabled / blocked / unreachable — fall back to a
        // private server channel. This keeps channel creation rare
        // rather than the default.
        console.log(`[ChallengeService] DM failed for ${discordId} (${dmErr.message}) — falling back to private channel`);
        dmUser = null;

        let username = discordId;
        try {
          const discordMember = await guild.members.fetch(discordId);
          username = discordMember.user.username;
        } catch { /* fall back to discord ID */ }

        fallbackChannel = await channelService.createPrivateChannel(
          guild,
          `invite-${username}`,
          [discordId],
        );
        challengePlayerRepo.setNotificationChannel(player.id, fallbackChannel.id);

        await fallbackChannel.send({
          content: `<@${discordId}>`,
          embeds: [embedPayload],
          components: [row],
        });
      }

      // ── Timeout timer — treat no response as decline ────────────
      const timerKey = `${challenge.id}_${player.id}`;
      const timer = setTimeout(async () => {
        teammateTimers.delete(timerKey);
        try {
          // Re-check the player's current status in case they already responded
          const currentPlayer = challengePlayerRepo.findById(player.id);
          if (!currentPlayer || currentPlayer.status !== PLAYER_STATUS.PENDING) return;

          challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);
          console.log(`[ChallengeService] Teammate ${player.user_id} timed out for challenge ${challenge.id}`);

          const timeoutText = t('notify_team.timeout_msg', lang);

          if (fallbackChannel) {
            try { await fallbackChannel.send(timeoutText); } catch { /* channel gone */ }
          } else if (dmUser) {
            try { await dmUser.send(timeoutText); } catch { /* DM now blocked */ }
          }

          await cancelChallenge(challenge.id);

          // Only the fallback channel can/should be deleted. DMs persist.
          if (fallbackChannel) {
            setTimeout(async () => {
              try { await channelService.deleteChannel(fallbackChannel); } catch { /* gone */ }
            }, 5000);
          }
        } catch (err) {
          console.error(`[ChallengeService] Error handling teammate timeout:`, err);
        }
      }, TIMERS.TEAMMATE_ACCEPT);

      teammateTimers.set(timerKey, timer);
    } catch (err) {
      console.error(`[ChallengeService] Error notifying teammate ${player.user_id}:`, err);
    }
  }
}

/**
 * Post the challenge to the public challenge board channel.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function postToBoard(client, challenge) {
  // Route cash match challenges to CHALLENGES_CHANNEL_ID, XP challenges to XP_CHALLENGES_CHANNEL_ID
  const channelId = challenge.type === 'xp'
    ? (process.env.XP_CHALLENGES_CHANNEL_ID || process.env.CHALLENGES_CHANNEL_ID)
    : process.env.CHALLENGES_CHANNEL_ID;
  if (!channelId) {
    console.error('[ChallengeService] Challenge channel ID not set');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`[ChallengeService] Challenge board channel ${channelId} not found in cache`);
    return;
  }

  // The board is shared, so the embed itself is in the bot display
  // language. Each user can click 🌐 to see this specific challenge
  // re-rendered in their own language as a personal ephemeral.
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const displayLang = getBotDisplayLanguage();

  // Build the embed — include team player names if not anonymous
  let teamPlayers = null;
  if (!challenge.is_anonymous) {
    const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
    teamPlayers = players.map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? { discord_id: u.discord_id, cod_ign: u.cod_ign, server_username: u.server_username } : null;
    }).filter(Boolean);
  }
  const embed = challengeEmbed(challenge, !!challenge.is_anonymous, teamPlayers, displayLang);

  // Build the accept + cancel buttons + inline language dropdown
  const { buildChallengeLanguageDropdown } = require('../interactions/perMessageLanguage');
  const { t } = require('../locales/i18n');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_accept_${challenge.id}`)
      .setLabel(t('challenge_create.btn_accept_challenge', displayLang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge_cancel_${challenge.id}`)
      .setLabel(t('challenge_create.btn_cancel_challenge', displayLang))
      .setStyle(ButtonStyle.Danger),
  );
  const langRow = buildChallengeLanguageDropdown(challenge.id, displayLang);

  const message = await channel.send({
    embeds: [embed],
    components: [row, langRow],
  });

  // Store message reference on the challenge
  challengeRepo.setMessageId(challenge.id, message.id, channel.id);

  // Ensure challenge status is 'open'
  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.OPEN);
  }

  // Create a challenge_expiry timer so the challenge auto-expires
  if (challenge.expires_at) {
    const remainingMs = new Date(challenge.expires_at).getTime() - Date.now();
    if (remainingMs > 0) {
      timerService.createTimer('challenge_expiry', challenge.id, remainingMs);
      console.log(`[ChallengeService] Created expiry timer for challenge #${challenge.id} (${remainingMs}ms)`);
    } else {
      // Already expired — fire immediately
      timerService.createTimer('challenge_expiry', challenge.id, 0);
      console.log(`[ChallengeService] ${challenge.type === 'cash_match' ? 'Cash Match' : 'XP Match'} #${challenge.display_number || challenge.id} already past expiry, firing immediately`);
    }
  }

  console.log(`[ChallengeService] Posted challenge #${challenge.id} to board (msg ${message.id})`);
}

/**
 * Cancel a challenge — refund all held funds, update status, clean up channels/messages.
 *
 * @param {number} challengeId - The challenge ID.
 */
async function cancelChallenge(challengeId) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    console.error(`[ChallengeService] Challenge ${challengeId} not found for cancellation`);
    return;
  }

  // Atomic status transition: only cancel from a pre-match state.
  // This prevents a race where cancelChallenge (from a teammate
  // timeout timer) runs at the same time as startMatch (from the
  // last teammate accepting). Without this, the cancel could refund
  // DB holds while startMatch is pulling the same funds into escrow.
  const CANCELLABLE = [
    CHALLENGE_STATUS.PENDING_TEAMMATES,
    CHALLENGE_STATUS.OPEN,
    CHALLENGE_STATUS.ACCEPTED,
  ];
  if (!CANCELLABLE.includes(challenge.status)) {
    console.log(`[ChallengeService] Challenge #${challengeId} is ${challenge.status} — not cancellable, skipping`);
    return;
  }
  const claimed = challengeRepo.atomicStatusTransition(challengeId, challenge.status, CHALLENGE_STATUS.CANCELLED);
  if (!claimed) {
    console.log(`[ChallengeService] Challenge #${challengeId} status changed before cancel could claim it — skipping`);
    return;
  }

  // Refund all held funds
  escrowManager.refundAll(challengeId);

  // Cancel any pending expiry timer for this challenge
  timerService.cancelTimersByReference('challenge_expiry', challengeId);

  // Clear any teammate accept timers for this challenge
  for (const [key, timer] of teammateTimers.entries()) {
    if (key.startsWith(`${challengeId}_`)) {
      clearTimeout(timer);
      teammateTimers.delete(key);
    }
  }

  // Delete any notification channels that were created
  const players = challengePlayerRepo.findByChallengeId(challengeId);
  for (const player of players) {
    if (player.notification_channel_id) {
      try {
        // We need to fetch the channel — but we don't have the client here.
        // The notification_channel_id is stored; callers with access to guild
        // should handle cleanup. We'll still attempt to note it.
        console.log(`[ChallengeService] Notification channel ${player.notification_channel_id} should be cleaned up for challenge ${challengeId}`);
      } catch {
        // Ignore
      }
    }
  }

  // If there's a challenge board message, attempt to note it for cleanup
  if (challenge.challenge_message_id && challenge.challenge_channel_id) {
    console.log(`[ChallengeService] Board message ${challenge.challenge_message_id} in ${challenge.challenge_channel_id} should be cleaned up for challenge ${challengeId}`);
  }

  console.log(`[ChallengeService] Challenge #${challengeId} cancelled`);
}

/**
 * Called when the last teammate accepts — updates status and posts to board.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function handleAllTeammatesAccepted(client, challenge) {
  // Atomic claim — two teammate accepts landing in the same tick can
  // both see pendingCount === 0 (there's an `await interaction.reply`
  // between the status write and the count read in teammateResponse),
  // and both call this function. Without the claim below, postToBoard
  // runs twice and the challenge appears on the board as a duplicate.
  // atomicStatusTransition uses BEGIN IMMEDIATE so only the first
  // caller wins PENDING_TEAMMATES -> OPEN.
  const claimed = challengeRepo.atomicStatusTransition(
    challenge.id,
    CHALLENGE_STATUS.PENDING_TEAMMATES,
    CHALLENGE_STATUS.OPEN,
  );
  if (!claimed) {
    console.log(`[ChallengeService] handleAllTeammatesAccepted race lost for #${challenge.id} \u2014 another caller already posted to the board`);
    return;
  }

  // Refresh the challenge record so postToBoard sees the updated status
  const updatedChallenge = challengeRepo.findById(challenge.id);

  // Post to the challenge board
  await postToBoard(client, updatedChallenge || challenge);

  console.log(`[ChallengeService] All teammates accepted for challenge #${challenge.id}, posted to board`);
}

/**
 * Clear a teammate timer (used when a teammate responds before timeout).
 *
 * @param {number} challengeId - The challenge ID.
 * @param {number} playerId - The challenge_player ID.
 */
function clearTeammateTimer(challengeId, playerId) {
  const key = `${challengeId}_${playerId}`;
  const timer = teammateTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    teammateTimers.delete(key);
  }
}

module.exports = {
  notifyTeammates,
  postToBoard,
  cancelChallenge,
  handleAllTeammatesAccepted,
  clearTeammateTimer,
};
