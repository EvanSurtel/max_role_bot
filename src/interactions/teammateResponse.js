const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../base/escrowManager');
const challengeService = require('../services/challengeService');
const matchService = require('../services/matchService');
const channelService = require('../services/channelService');
const { CHALLENGE_STATUS, PLAYER_STATUS, CHALLENGE_TYPE } = require('../config/constants');
const { t, langFor } = require('../locales/i18n');

/**
 * Handle button interactions for teammate accept/decline responses.
 * CustomId format: teammate_accept_{challengeId} or teammate_decline_{challengeId}
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButton(interaction) {
  const customId = interaction.customId;

  // Parse action and challenge ID
  let action, challengeId;
  if (customId.startsWith('teammate_confirm_accept_')) {
    action = 'accept';
    challengeId = parseInt(customId.replace('teammate_confirm_accept_', ''), 10);
  } else if (customId.startsWith('teammate_confirm_decline_')) {
    action = 'confirm_decline';
    challengeId = parseInt(customId.replace('teammate_confirm_decline_', ''), 10);
  } else if (customId.startsWith('teammate_accept_')) {
    action = 'accept_pending';
    challengeId = parseInt(customId.replace('teammate_accept_', ''), 10);
  } else if (customId.startsWith('teammate_decline_')) {
    action = 'decline';
    challengeId = parseInt(customId.replace('teammate_decline_', ''), 10);
  } else {
    return;
  }

  const lang = langFor(interaction);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('teammate.invalid_reference', lang), ephemeral: true });
  }

  const discordId = interaction.user.id;

  // Find the user in DB
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({
      content: t('common.onboarding_required', lang),
      ephemeral: true,
    });
  }

  // Find the challenge
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: t('teammate.challenge_no_longer_exists', lang), ephemeral: true });
  }

  // Find the challenge_player record for this user
  const player = challengePlayerRepo.findByChallengeAndUser(challengeId, user.id);
  if (!player) {
    return interaction.reply({ content: t('teammate.not_in_challenge', lang), ephemeral: true });
  }

  // Validate challenge status — team 1 uses 'pending_teammates', team 2 uses 'accepted'
  const validStatuses = [CHALLENGE_STATUS.PENDING_TEAMMATES, CHALLENGE_STATUS.ACCEPTED];
  if (!validStatuses.includes(challenge.status)) {
    return interaction.reply({
      content: t('teammate.not_waiting_teammates', lang),
      ephemeral: true,
    });
  }

  // Validate player status
  if (player.status !== PLAYER_STATUS.PENDING) {
    return interaction.reply({
      content: t('teammate.already_responded', lang),
      ephemeral: true,
    });
  }

  // Clear the teammate timeout timer since they responded
  // For initial accept click, show confirmation (don't clear timer yet)
  if (action === 'accept_pending') {
    return showAcceptConfirm(interaction, challenge, player, user);
  }

  // Clear timer only on confirmed accept or decline
  challengeService.clearTeammateTimer(challengeId, player.id);

  if (action === 'accept') {
    return handleAccept(interaction, challenge, player, user);
  } else if (action === 'decline') {
    return showDeclineConfirm(interaction, challenge, player, user);
  } else if (action === 'confirm_decline') {
    return handleDecline(interaction, challenge, player, user);
  }
}

/**
 * Show confirmation before accepting team invite.
 */
async function showAcceptConfirm(interaction, challenge, player, user) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const { GAME_MODES, CHALLENGE_TYPE } = require('../config/constants');

  const lang = langFor(interaction);
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const entryAmount = (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2);
  const entryText = isCashMatch && Number(challenge.entry_amount_usdc) > 0
    ? '\n' + t('teammate.confirm_entry_held', lang, { amount: entryAmount })
    : '';

  const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const displayNum = challenge.display_number || challenge.id;

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('teammate.confirm_accept_title', lang))
    .setColor(0x2ecc71)
    .setDescription([
      t('teammate.confirm_accept_intro', lang, { type: typeLabel, num: displayNum }),
      '',
      `**${t('challenge_create.confirm_field_type', lang)}:** ${typeLabel}`,
      `**${t('challenge_create.confirm_field_team_size', lang)}:** ${challenge.team_size}v${challenge.team_size}`,
      `**${t('challenge_create.confirm_field_mode', lang)}:** ${modeLabel}`,
      `**${t('challenge_create.confirm_field_series', lang)}:** ${t('challenge_create.series_label', lang, { n: challenge.series_length })}`,
      entryText,
      '',
      t('teammate.confirm_question', lang),
    ].join('\n'));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`teammate_confirm_accept_${challenge.id}`)
      .setLabel(t('teammate.btn_yes_join', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`teammate_decline_${challenge.id}`)
      .setLabel(t('teammate.btn_decline', lang))
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Show confirmation before declining team invite.
 */
async function showDeclineConfirm(interaction, challenge, player, user) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const lang = langFor(interaction);

  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const typeLowerLabel = typeLabel.toLowerCase();
  const refundNotice = isCashMatch ? t('teammate.refund_notice_cash_match', lang) : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('teammate.confirm_decline_title', lang))
    .setColor(0xe74c3c)
    .setDescription(t('teammate.confirm_decline_q', lang, {
      type: typeLabel,
      type_lower: typeLowerLabel,
      num: challenge.display_number || challenge.id,
      refund_notice: refundNotice,
    }));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`teammate_confirm_decline_${challenge.id}`)
      .setLabel(t('teammate.btn_yes_decline', lang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`teammate_accept_${challenge.id}`)
      .setLabel(t('teammate.btn_go_back', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Handle a teammate accepting the challenge invitation.
 */
async function handleAccept(interaction, challenge, player, user) {
  const lang = langFor(interaction);

  // For cash match challenges, check balance and hold funds
  if (challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.entry_amount_usdc) > 0) {
    const entryUsdc = challenge.entry_amount_usdc.toString();

    if (!escrowManager.canAfford(user.id, entryUsdc)) {
      const entryAmount = (Number(entryUsdc) / 1_000_000).toFixed(2);
      return interaction.reply({
        content: t('teammate.not_enough_funds', lang, { amount: entryAmount }),
        ephemeral: true,
      });
    }

    const held = escrowManager.holdFunds(user.id, entryUsdc, challenge.id);
    if (!held) {
      return interaction.reply({
        content: t('teammate.failed_hold', lang),
        ephemeral: true,
      });
    }

    // Mark funds as held on the player record
    challengePlayerRepo.setFundsHeld(player.id, true);
  }

  // Update player status to accepted
  challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.ACCEPTED);

  const { postTransaction } = require('../utils/transactionFeed');
  const isCashMatch2 = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const tl = isCashMatch2 ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const dn = challenge.display_number || challenge.id;
  postTransaction({ type: 'teammate_accepted', username: user.server_username, discordId: user.discord_id, challengeId: challenge.id, memo: `Joined team for ${tl} #${dn}` });

  // Reply confirming acceptance — cash match wording mentions held funds, XP doesn't
  const acceptKey = isCashMatch2 ? 'teammate.accept_msg_cash_match' : 'teammate.accept_msg_xp';
  await interaction.reply({ content: t(acceptKey, lang, { type: tl, num: dn }) });

  // Check if all players are now accepted
  const pendingCount = challengePlayerRepo.countPendingByChallenge(challenge.id);

  if (pendingCount === 0) {
    if (challenge.status === CHALLENGE_STATUS.PENDING_TEAMMATES) {
      // Team 1 complete — post challenge to the board
      await challengeService.handleAllTeammatesAccepted(interaction.client, challenge);
    } else if (challenge.status === CHALLENGE_STATUS.ACCEPTED) {
      // Team 2 complete — start the match (transfer to escrow + create channels)
      try {
        await matchService.startMatch(interaction.client, challenge.id);
      } catch (err) {
        console.error(`[TeammateResponse] Error starting match for challenge ${challenge.id}:`, err);
      }
    }
  }

  // Delete the notification channel after a short delay — only when
  // the invite came via a private server channel. DMs persist and
  // can't be deleted by the bot.
  if (interaction.inGuild()) {
    const channel = interaction.channel;
    setTimeout(async () => {
      try {
        await channelService.deleteChannel(channel);
      } catch (err) {
        console.error(`[TeammateResponse] Error deleting notification channel:`, err);
      }
    }, 5000);
  }
}

/**
 * Handle a teammate declining the challenge invitation.
 */
async function handleDecline(interaction, challenge, player, user) {
  const lang = langFor(interaction);

  // Update player status to declined
  challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);

  const { postTransaction } = require('../utils/transactionFeed');
  const isCashMatch3 = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const dtl = isCashMatch3 ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const ddn = challenge.display_number || challenge.id;
  postTransaction({ type: 'teammate_declined', username: user.server_username, discordId: user.discord_id, challengeId: challenge.id, memo: `Declined team invite for ${dtl} #${ddn}` });

  await interaction.reply({
    content: t('teammate.decline_msg', lang, { type: dtl, type_lower: dtl.toLowerCase(), num: ddn }),
  });

  // Notify the creator in their saved language
  try {
    const creator = userRepo.findById(challenge.creator_user_id);
    if (creator) {
      const creatorDiscord = await interaction.client.users.fetch(creator.discord_id);
      if (creatorDiscord) {
        const { getLang } = require('../locales/i18n');
        const creatorLang = getLang(creator.discord_id);
        const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
        const creatorTypeLabel = isCashMatch ? t('challenge_create.type_cash_match', creatorLang) : t('challenge_create.type_xp_match', creatorLang);
        await creatorDiscord.send(
          t('teammate.decline_creator_dm', creatorLang, {
            type: creatorTypeLabel,
            num: challenge.display_number || challenge.id,
            player: `<@${user.discord_id}>`,
          }),
        ).catch(() => {
          // DMs may be disabled; this is non-critical
          console.log(`[TeammateResponse] Could not DM creator ${creator.discord_id} about decline`);
        });
      }
    }
  } catch (err) {
    console.error('[TeammateResponse] Error notifying creator of decline:', err);
  }

  // Cancel the entire challenge (refunds all held funds)
  await challengeService.cancelChallenge(challenge.id);

  // Delete the notification channel after a short delay — only when
  // the invite came via a private server channel. DMs persist.
  if (interaction.inGuild()) {
    const channel = interaction.channel;
    setTimeout(async () => {
      try {
        await channelService.deleteChannel(channel);
      } catch (err) {
        console.error(`[TeammateResponse] Error deleting notification channel:`, err);
      }
    }, 5000);
  }
}

module.exports = { handleButton };
