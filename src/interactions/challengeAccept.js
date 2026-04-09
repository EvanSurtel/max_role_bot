const { ActionRowBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../solana/escrowManager');
const matchService = require('../services/matchService');
const challengeService = require('../services/challengeService');
const { CHALLENGE_STATUS, PLAYER_STATUS, PLAYER_ROLE, CHALLENGE_TYPE } = require('../config/constants');
const { challengeEmbed, formatUsdc } = require('../utils/embeds');
const { t, langFor } = require('../locales/i18n');

// Track in-progress acceptance flows for team games
const acceptFlows = new Map(); // discordUserId -> { challengeId, teammates: [] }

/**
 * Handle button interactions for accepting a challenge from the public board.
 * customId format: challenge_accept_${challengeId}
 */
async function handleButton(interaction) {
  const customId = interaction.customId;
  const lang = langFor(interaction);
  const challengeId = parseInt(customId.replace('challenge_accept_', ''), 10);

  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('common.invalid_challenge', lang), ephemeral: true });
  }

  // Find the challenge
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: t('common.challenge_not_found', lang), ephemeral: true });
  }

  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    return interaction.reply({ content: t('common.challenge_not_available', lang), ephemeral: true });
  }

  // Find or create the user in DB
  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user || !user.cod_uid) {
    return interaction.reply({
      content: t('common.not_registered', lang),
      ephemeral: true,
    });
  }

  // Check user is not already a player in this challenge (can't accept your own challenge)
  const existingPlayer = challengePlayerRepo.findByChallengeAndUser(challengeId, user.id);
  if (existingPlayer) {
    return interaction.reply({
      content: t('common.you_already_in_challenge', lang),
      ephemeral: true,
    });
  }

  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const entryUsdc = challenge.entry_amount_usdc;

  // Prevent accepting own challenge
  if (challenge.creator_user_id === user.id) {
    return interaction.reply({ content: t('common.cannot_accept_own', lang), ephemeral: true });
  }

  const { GAME_MODES } = require('../config/constants');
  const typeLabel = isWager ? t('challenge_create.type_wager', lang) : t('challenge_create.type_xp_match', lang);
  const displayNum = challenge.display_number || challengeId;

  // 1v1: show confirmation directly
  if (challenge.team_size === 1) {
    const modeInfo = GAME_MODES[challenge.game_modes];
    const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
    const entryAmountFormatted = (Number(entryUsdc) / 1_000_000).toFixed(2);
    const entryText = isWager ? `\n**${t('challenge_create.confirm_field_entry', lang)}:** $${entryAmountFormatted} USDC` : '';

    const confirmEmbed = new EmbedBuilder()
      .setTitle(t('challenge_accept.confirm_title', lang))
      .setColor(0xe67e22)
      .setDescription([
        t('challenge_accept.confirm_about_to_accept', lang, { type: typeLabel, num: displayNum }),
        '',
        `**${t('challenge_create.confirm_field_type', lang)}:** ${typeLabel}`,
        `**${t('challenge_create.confirm_field_team_size', lang)}:** 1v1`,
        `**${t('challenge_create.confirm_field_mode', lang)}:** ${modeLabel}`,
        `**${t('challenge_create.confirm_field_series', lang)}:** ${t('challenge_create.series_label', lang, { n: challenge.series_length })}`,
        entryText,
        '',
        isWager ? t('challenge_accept.confirm_held_notice', lang, { amount: entryAmountFormatted }) : '',
        '',
        t('challenge_accept.confirm_question', lang),
      ].join('\n'));

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`challenge_confirm_${challengeId}`)
        .setLabel(t('challenge_accept.btn_yes_accept', lang))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`challenge_nevermind_${challengeId}`)
        .setLabel(t('challenge_accept.btn_nevermind', lang))
        .setStyle(ButtonStyle.Secondary),
    );

    return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
  }

  // Team games: show teammate select first (confirmation comes after selection)
  acceptFlows.set(discordId, { challengeId, teammates: [] });

  const teammatesNeeded = challenge.team_size - 1;
  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_opponents_${challengeId}`)
      .setPlaceholder(t('challenge_create.select_teammates_placeholder', lang, { count: teammatesNeeded }))
      .setMinValues(teammatesNeeded)
      .setMaxValues(teammatesNeeded),
  );

  return interaction.reply({
    content: t('challenge_accept.select_opponents_header', lang, { type: typeLabel, num: displayNum, size: challenge.team_size, count: teammatesNeeded }),
    components: [selectRow],
    ephemeral: true,
  });
}

/**
 * Handle the confirmed acceptance after the user clicks "Yes, Accept".
 */
async function handleConfirmedAccept(interaction) {
  const lang = langFor(interaction);
  const challengeId = parseInt(interaction.customId.replace('challenge_confirm_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('common.invalid_challenge', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
    return interaction.reply({ content: t('common.challenge_not_available', lang), ephemeral: true });
  }

  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user || !user.cod_uid) {
    return interaction.reply({ content: t('common.not_registered', lang), ephemeral: true });
  }

  // Check if acceptor is busy
  const { isPlayerBusy } = require('../utils/playerStatus');
  const busy = isPlayerBusy(user.id);
  if (busy.busy) {
    return interaction.reply({ content: busy.reason, ephemeral: true });
  }

  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const entryUsdc = challenge.entry_amount_usdc;

  // 1v1 challenges — immediate acceptance
  if (challenge.team_size === 1) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Atomically claim the challenge — prevents double-accept race condition
      const claimed = challengeRepo.atomicStatusTransition(challengeId, CHALLENGE_STATUS.OPEN, CHALLENGE_STATUS.IN_PROGRESS);
      if (!claimed) {
        return interaction.editReply({ content: t('challenge_accept.already_accepted', lang) });
      }

      // Check balance and hold funds (if wager)
      if (isWager && Number(entryUsdc) > 0) {
        const entryAmount = (Number(entryUsdc) / 1_000_000).toFixed(2);
        if (!escrowManager.canAfford(user.id, entryUsdc)) {
          return interaction.editReply({
            content: t('challenge_accept.insufficient_accept', lang, { amount: entryAmount }),
          });
        }

        const held = escrowManager.holdFunds(user.id, entryUsdc, challengeId);
        if (!held) {
          return interaction.editReply({
            content: t('challenge_create.failed_hold_funds', lang),
          });
        }
      }

      // Add as team 2 captain (accepted, funds_held)
      challengePlayerRepo.create({
        challengeId,
        userId: user.id,
        team: 2,
        role: PLAYER_ROLE.CAPTAIN,
        status: PLAYER_STATUS.ACCEPTED,
        fundsHeld: (isWager && Number(entryUsdc) > 0) ? 1 : 0,
      });

      // Set challenge acceptor
      challengeRepo.setAcceptor(challengeId, user.id);

      // Transfer ALL players' held funds to escrow
      if (isWager && Number(entryUsdc) > 0) {
        const allPlayers = challengePlayerRepo.findByChallengeId(challengeId);
        for (const player of allPlayers) {
          if (player.funds_held) {
            try {
              await escrowManager.transferToEscrow(player.user_id, entryUsdc, challengeId);
            } catch (err) {
              console.error(`[ChallengeAccept] Failed to transfer escrow for player ${player.user_id}:`, err.message);
            }
          }
        }
      }

      // Create match channels
      await matchService.createMatchChannels(interaction.client, challenge);

      // Edit the challenge board message to show "ACCEPTED" and disable the button
      await disableBoardMessage(interaction.client, challenge);

      // Log to admin feed
      const { postTransaction } = require('../utils/transactionFeed');
      postTransaction({ type: 'challenge_accepted', username: user.server_username, discordId: discordId, challengeId, memo: `${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #${challenge.display_number || challengeId} accepted by ${user.server_username} (1v1)` });

      const typeLabelDone = isWager ? t('challenge_create.type_wager', lang) : t('challenge_create.type_xp_match', lang);
      return interaction.editReply({
        content: t('challenge_accept.accepted_msg', lang, { type: typeLabelDone, num: challenge.display_number || challengeId }),
      });
    } catch (err) {
      console.error(`[ChallengeAccept] Error accepting 1v1 challenge #${challengeId}:`, err);
      // Refund all held funds on failure
      try { escrowManager.refundAll(challengeId); } catch { /* */ }
      challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.OPEN);
      return interaction.editReply({
        content: t('challenge_accept.failed_to_accept', lang),
      });
    }
  }

  // Team games (2v2+) — need to select teammates first
  acceptFlows.set(discordId, { challengeId, teammates: [] });

  const teammatesNeeded = challenge.team_size - 1;
  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_opponents_${challengeId}`)
      .setPlaceholder(`Select ${teammatesNeeded} teammate(s)`)
      .setMinValues(teammatesNeeded)
      .setMaxValues(teammatesNeeded),
  );

  return interaction.reply({
    content: `**Select your teammates for ${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #${challenge.display_number || challengeId}:**\n\nTeam size: **${challenge.team_size}v${challenge.team_size}** — Pick **${teammatesNeeded}** teammate(s).`,
    components: [selectRow],
    ephemeral: true,
  });
}

/**
 * Build the teammate review UI for the acceptance flow — list of
 * currently-picked teammates with Remove buttons, plus Add More /
 * Continue actions.
 */
function buildAcceptTeammateReviewUI(flow, challenge, lang) {
  const required = challenge.team_size - 1;
  const current = flow.teammates.length;
  const isFull = current >= required;
  const challengeId = flow.challengeId;

  const lines = [
    t('challenge_create.teammates_review_title', lang, { current, required }),
    '',
    ...flow.teammates.map((id, i) => `${i + 1}. <@${id}>`),
  ];
  if (!isFull) {
    lines.push('');
    lines.push(t('challenge_create.teammates_need_more', lang, { n: required - current }));
  }

  const removeRows = [];
  for (let i = 0; i < flow.teammates.length; i += 5) {
    const chunk = flow.teammates.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map((discordId, j) =>
        new ButtonBuilder()
          .setCustomId(`accept_remove_tm_${challengeId}_${discordId}`)
          .setLabel(`✕ ${i + j + 1}`)
          .setStyle(ButtonStyle.Danger),
      ),
    );
    removeRows.push(row);
  }

  const actionRow = new ActionRowBuilder();
  if (!isFull) {
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_add_more_tm_${challengeId}`)
        .setLabel(t('challenge_create.btn_add_more_teammates', lang))
        .setStyle(ButtonStyle.Primary),
    );
  }
  actionRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_tm_continue_${challengeId}`)
      .setLabel(t('challenge_create.btn_continue', lang))
      .setStyle(ButtonStyle.Success)
      .setDisabled(!isFull),
    new ButtonBuilder()
      .setCustomId(`challenge_nevermind_${challengeId}`)
      .setLabel(t('challenge_accept.btn_nevermind', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: lines.join('\n'),
    embeds: [],
    components: [...removeRows, actionRow],
  };
}

/**
 * Show the final acceptance confirmation embed (called when the user
 * has selected all teammates and clicked Continue).
 */
async function showAcceptanceConfirmation(interaction, flow, challenge, lang) {
  const discordId = interaction.user.id;
  const { GAME_MODES } = require('../config/constants');
  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const entryUsdc = challenge.entry_amount_usdc;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const challengeId = challenge.id;

  const team1Players = challengePlayerRepo.findByChallengeAndTeam(challengeId, 1);
  const team1Lines = team1Players.map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? `<@${u.discord_id}>${p.role === 'captain' ? ' (Captain)' : ''}` : 'Unknown';
  });

  const team2Lines = [`<@${discordId}> (Captain)`];
  for (const tmId of flow.teammates) team2Lines.push(`<@${tmId}>`);

  const entryText = isWager
    ? `\n**${t('challenge_create.confirm_field_entry', lang)}:** ${formatUsdc(entryUsdc)} USDC ${t('challenge_create.per_player', lang)}\n**${t('challenge_create.confirm_field_pot', lang)}:** ${formatUsdc(Number(entryUsdc) * challenge.team_size * 2)} USDC`
    : '';

  const typeLabel = isWager ? t('challenge_create.type_wager', lang) : t('challenge_create.type_xp_match', lang);

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('challenge_accept.confirm_title', lang))
    .setColor(0xe67e22)
    .setDescription([
      `**${typeLabel} #${challenge.display_number || challengeId}**`,
      '',
      `**${t('challenge_create.confirm_field_type', lang)}:** ${typeLabel}`,
      `**${t('challenge_create.confirm_field_mode', lang)}:** ${modeLabel} | ${t('challenge_create.series_label', lang, { n: challenge.series_length })} | ${challenge.team_size}v${challenge.team_size}`,
      entryText,
      '',
      `**Team 1:**`,
      ...team1Lines,
      '',
      `**Team 2 (Your Team):**`,
      ...team2Lines,
      '',
      isWager ? t('challenge_accept.confirm_held_notice', lang, { amount: formatUsdc(entryUsdc).replace('$', '') }) : '',
      '',
      t('challenge_accept.confirm_question_correct', lang),
    ].join('\n'));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_team_confirm_${challengeId}`)
      .setLabel(t('challenge_accept.btn_confirm_accept', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge_nevermind_${challengeId}`)
      .setLabel(t('challenge_accept.btn_nevermind', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [confirmRow], content: '' });
}

/**
 * Handle user select menu interactions for opponent teammate selection.
 * customId format: select_opponents_${challengeId}
 *
 * Picks are merged into the existing flow.teammates list (so users can
 * incrementally add). After every pick, the review screen is shown
 * with Remove / Add More / Continue buttons.
 */
async function handleUserSelect(interaction) {
  const customId = interaction.customId;
  const lang = langFor(interaction);
  const challengeId = parseInt(customId.replace('select_opponents_', ''), 10);
  const discordId = interaction.user.id;

  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('common.invalid_challenge', lang), ephemeral: true });
  }

  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({
      content: t('common.session_expired_simple', lang),
      ephemeral: true,
    });
  }

  const selectedDiscordIds = interaction.values;

  try {
    const challenge = challengeRepo.findById(challengeId);
    if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
      acceptFlows.delete(discordId);
      return interaction.update({
        content: t('common.challenge_not_available', lang),
        components: [],
        embeds: [],
      });
    }

    // Reject self-selection
    if (selectedDiscordIds.includes(discordId)) {
      return interaction.reply({ content: t('common.cannot_select_yourself', lang), ephemeral: true });
    }

    // Validate each picked teammate
    const { isPlayerBusy } = require('../utils/playerStatus');
    for (const teammateDiscordId of selectedDiscordIds) {
      if (flow.teammates.includes(teammateDiscordId)) {
        return interaction.reply({ content: t('common.teammate_already_in', lang, { user: `<@${teammateDiscordId}>` }), ephemeral: true });
      }
      const teammateUser = userRepo.findByDiscordId(teammateDiscordId);
      if (!teammateUser || !teammateUser.cod_uid) {
        return interaction.reply({ content: t('common.teammate_not_registered', lang, { user: `<@${teammateDiscordId}>` }), ephemeral: true });
      }
      const existing = challengePlayerRepo.findByChallengeAndUser(challengeId, teammateUser.id);
      if (existing) {
        return interaction.reply({ content: t('common.teammate_already_in', lang, { user: `<@${teammateDiscordId}>` }), ephemeral: true });
      }
      const busy = isPlayerBusy(teammateUser.id);
      if (busy.busy) {
        return interaction.reply({ content: t('common.teammate_busy', lang, { user: `<@${teammateDiscordId}>`, reason: busy.reason }), ephemeral: true });
      }
    }

    // Merge new picks with existing list
    flow.teammates = [...flow.teammates, ...selectedDiscordIds];

    const user = userRepo.findByDiscordId(discordId);
    if (!user) {
      acceptFlows.delete(discordId);
      return interaction.update({ content: t('common.onboarding_required', lang), components: [], embeds: [] });
    }

    // Show the review screen — user can add/remove until they hit Continue
    return interaction.update(buildAcceptTeammateReviewUI(flow, challenge, lang));

  } catch (err) {
    console.error(`[ChallengeAccept] Error in team select for challenge #${challengeId}:`, err);
    return interaction.reply({ content: t('common.error_generic', lang), ephemeral: true });
  }
}

/**
 * Handle the Remove (✕) button on a teammate in the acceptance review.
 * customId: accept_remove_tm_{challengeId}_{teammateDiscordId}
 */
async function handleRemoveTeammate(interaction) {
  const lang = langFor(interaction);
  const parts = interaction.customId.replace('accept_remove_tm_', '').split('_');
  const challengeId = parseInt(parts[0], 10);
  const removedDiscordId = parts.slice(1).join('_');
  const discordId = interaction.user.id;

  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({ content: t('common.session_expired_simple', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
    acceptFlows.delete(discordId);
    return interaction.update({ content: t('common.challenge_not_available', lang), components: [], embeds: [] });
  }

  flow.teammates = flow.teammates.filter(d => d !== removedDiscordId);
  return interaction.update(buildAcceptTeammateReviewUI(flow, challenge, lang));
}

/**
 * Handle "Add More" — re-open the UserSelect picker for the remaining slots.
 * customId: accept_add_more_tm_{challengeId}
 */
async function handleAddMoreTeammate(interaction) {
  const lang = langFor(interaction);
  const challengeId = parseInt(interaction.customId.replace('accept_add_more_tm_', ''), 10);
  const discordId = interaction.user.id;

  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({ content: t('common.session_expired_simple', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
    acceptFlows.delete(discordId);
    return interaction.update({ content: t('common.challenge_not_available', lang), components: [], embeds: [] });
  }

  const remaining = (challenge.team_size - 1) - flow.teammates.length;
  if (remaining <= 0) {
    return interaction.reply({ content: t('challenge_create.teammates_already_full', lang), ephemeral: true });
  }

  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_opponents_${challengeId}`)
      .setPlaceholder(t('challenge_create.select_teammates_placeholder', lang, { count: remaining }))
      .setMinValues(1)
      .setMaxValues(remaining),
  );

  return interaction.update({
    content: t('challenge_create.add_more_teammates_prompt', lang, { n: remaining }),
    components: [selectRow],
    embeds: [],
  });
}

/**
 * Handle "Continue" from the teammate review — show final confirmation.
 * customId: accept_tm_continue_{challengeId}
 */
async function handleContinueTeammates(interaction) {
  const lang = langFor(interaction);
  const challengeId = parseInt(interaction.customId.replace('accept_tm_continue_', ''), 10);
  const discordId = interaction.user.id;

  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({ content: t('common.session_expired_simple', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
    acceptFlows.delete(discordId);
    return interaction.update({ content: t('common.challenge_not_available', lang), components: [], embeds: [] });
  }

  if (flow.teammates.length !== challenge.team_size - 1) {
    return interaction.reply({
      content: t('challenge_create.need_exact_teammates', lang, { n: challenge.team_size - 1 }),
      ephemeral: true,
    });
  }

  return showAcceptanceConfirmation(interaction, flow, challenge, lang);
}

/**
 * Handle confirmed team acceptance after teammate selection.
 */
async function handleTeamConfirmedAccept(interaction) {
  const challengeId = parseInt(interaction.customId.replace('challenge_team_confirm_', ''), 10);
  if (isNaN(challengeId)) return interaction.reply({ content: 'Invalid.', ephemeral: true });

  const discordId = interaction.user.id;
  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({ content: 'Session expired. Please try again.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
    acceptFlows.delete(discordId);
    return interaction.update({ content: 'This challenge is no longer available.', embeds: [], components: [] });
  }

  const user = userRepo.findByDiscordId(discordId);
  if (!user) return interaction.reply({ content: 'Not registered.', ephemeral: true });

  const selectedDiscordIds = flow.teammates;
  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const entryUsdc = challenge.entry_amount_usdc;

  await interaction.update({ content: 'Processing...', embeds: [], components: [] });

  try {
    // Check acceptor's balance and hold funds (if wager)
    if (isWager && Number(entryUsdc) > 0) {
      if (!escrowManager.canAfford(user.id, entryUsdc)) {
        acceptFlows.delete(discordId);
        return interaction.editReply({
          content: `Insufficient balance. You need **${formatUsdc(entryUsdc)} USDC** to accept this wager.`,
          components: [],
        });
      }

      const held = escrowManager.holdFunds(user.id, entryUsdc, challengeId);
      if (!held) {
        acceptFlows.delete(discordId);
        return interaction.editReply({
          content: 'Failed to hold funds. Please try again.',
          components: [],
        });
      }
    }

    // Add acceptor as team 2 captain (accepted, funds_held)
    challengePlayerRepo.create({
      challengeId,
      userId: user.id,
      team: 2,
      role: PLAYER_ROLE.CAPTAIN,
      status: PLAYER_STATUS.ACCEPTED,
      fundsHeld: (isWager && Number(entryUsdc) > 0) ? 1 : 0,
    });

    // Add teammates as team 2 pending players
    for (const teammateDiscordId of selectedDiscordIds) {
      const teammateUser = userRepo.findByDiscordId(teammateDiscordId);
      if (teammateUser) {
        challengePlayerRepo.create({
          challengeId,
          userId: teammateUser.id,
          team: 2,
          role: PLAYER_ROLE.PLAYER,
          status: PLAYER_STATUS.PENDING,
        });
      } else {
        console.warn(`[ChallengeAccept] Teammate ${teammateDiscordId} not found in DB (not onboarded)`);
      }
    }

    // Set challenge status to 'accepted' (waiting for opponent teammates)
    challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.ACCEPTED);

    // Set challenge acceptor
    challengeRepo.setAcceptor(challengeId, user.id);

    // Notify opponent teammates using the same pattern as team 1 notifications
    // We need the guild to create notification channels
    const guild = interaction.guild;
    if (guild) {
      // Refresh challenge record to get updated status
      const updatedChallenge = challengeRepo.findById(challengeId);
      await notifyTeam2Teammates(guild, updatedChallenge || challenge);
    }

    // Clean up acceptFlows
    acceptFlows.delete(discordId);

    // Edit the challenge board message to show "ACCEPTED" and disable the button
    await disableBoardMessage(interaction.client, challenge);

    // Reply to acceptor confirming
    const teammatesMention = selectedDiscordIds.map(id => `<@${id}>`).join(', ');
    return interaction.editReply({
      content: [
        `**${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #${challenge.display_number || challengeId} accepted!**`,
        '',
        `Your teammates (${teammatesMention}) have been notified.`,
        'Once all teammates accept, the match will begin and channels will be created.',
      ].join('\n'),
      components: [],
    });
  } catch (err) {
    console.error(`[ChallengeAccept] Error in team accept flow for challenge #${challengeId}:`, err);
    acceptFlows.delete(discordId);
    return interaction.editReply({
      content: 'Something went wrong. Please try again.',
      components: [],
    });
  }
}

/**
 * Notify team 2 pending teammates about the challenge invitation.
 * Reuses the same private channel + accept/decline button pattern as team 1.
 *
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {object} challenge - The challenge DB record.
 */
async function notifyTeam2Teammates(guild, challenge) {
  const channelService = require('../services/channelService');
  const { GAME_MODES, TIMERS, CHALLENGE_TYPE: CT } = require('../config/constants');

  const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 2);
  const pendingPlayers = players.filter(p => p.status === PLAYER_STATUS.PENDING);

  for (const player of pendingPlayers) {
    try {
      const user = userRepo.findById(player.user_id);
      if (!user) {
        console.error(`[ChallengeAccept] No user found for player ${player.user_id}`);
        continue;
      }

      const playerDiscordId = user.discord_id;

      // Resolve the Discord user to get their username for the channel name
      let username = playerDiscordId;
      try {
        const discordMember = await guild.members.fetch(playerDiscordId);
        username = discordMember.user.username;
      } catch {
        // Fall back to discord ID if we can't fetch the member
      }

      // Create a private channel for this teammate
      const channel = await channelService.createPrivateChannel(
        guild,
        `invite-${username}`,
        [playerDiscordId],
      );

      // Store the channel ID on the challenge_player record
      challengePlayerRepo.setNotificationChannel(player.id, channel.id);

      // Build challenge details
      const isWager = challenge.type === CT.WAGER;
      const modeInfo = GAME_MODES[challenge.game_modes];
      const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

      const acceptor = userRepo.findById(challenge.acceptor_user_id);
      const acceptorMention = acceptor ? `<@${acceptor.discord_id}>` : 'Unknown';

      const description = [
        `${acceptorMention} has invited you to join their team!`,
        '',
        `**Type:** ${isWager ? 'Wager' : 'XP Match'}`,
        `**Team Size:** ${challenge.team_size}v${challenge.team_size}`,
        `**Game Mode:** ${modeLabel}`,
        `**Series:** Best of ${challenge.series_length}`,
      ];

      if (isWager) {
        const entry = formatUsdc(challenge.entry_amount_usdc);
        description.push(`**Entry:** ${entry} USDC per player`);
      }

      description.push('', `You have **${TIMERS.TEAMMATE_ACCEPT / 60000} minutes** to accept or decline.`);

      // Build buttons — same customIds as team 1 so teammateResponse.js handles them
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`teammate_accept_${challenge.id}`)
          .setLabel('Accept')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`teammate_decline_${challenge.id}`)
          .setLabel('Decline')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({
        content: `<@${playerDiscordId}>`,
        embeds: [
          {
            title: `Team Invite — ${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #${challenge.display_number || challenge.id}`,
            description: description.join('\n'),
            color: isWager ? 0xf1c40f : 0x3498db,
          },
        ],
        components: [row],
      });

      // Start a timeout timer — treat as decline if no response
      const challengeServiceRef = require('../services/challengeService');
      const timerKey = `${challenge.id}_${player.id}`;

      const timer = setTimeout(async () => {
        try {
          // Re-check the player's current status in case they already responded
          const currentPlayer = challengePlayerRepo.findById(player.id);
          if (!currentPlayer || currentPlayer.status !== PLAYER_STATUS.PENDING) return;

          // Treat as decline
          challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);
          console.log(`[ChallengeAccept] Teammate ${player.user_id} timed out for challenge ${challenge.id}`);

          // Notify in the channel before deleting
          try {
            await channel.send('You did not respond in time. The invitation has expired and the challenge has been cancelled.');
          } catch {
            // Channel may already be deleted
          }

          // Cancel the entire challenge
          await challengeServiceRef.cancelChallenge(challenge.id);

          // Delete the channel after a short delay
          setTimeout(async () => {
            try {
              const channelSvc = require('../services/channelService');
              await channelSvc.deleteChannel(channel);
            } catch {
              // Channel may already be gone
            }
          }, 5000);
        } catch (err) {
          console.error(`[ChallengeAccept] Error handling teammate timeout:`, err);
        }
      }, TIMERS.TEAMMATE_ACCEPT);

      // Register the timer with challengeService so it can be cleared
      // We use the same clearTeammateTimer approach
      // Store locally for now — the timer will self-clean on fire
      console.log(`[ChallengeAccept] Notified team 2 teammate ${playerDiscordId} in channel ${channel.id} for challenge ${challenge.id}`);
    } catch (err) {
      console.error(`[ChallengeAccept] Error notifying team 2 teammate ${player.user_id}:`, err);
    }
  }
}

/**
 * Edit the challenge board message to show it has been accepted and disable the button.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function disableBoardMessage(client, challenge) {
  if (!challenge.challenge_message_id || !challenge.challenge_channel_id) return;

  try {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (!boardChannel) return;

    const message = await boardChannel.messages.fetch(challenge.challenge_message_id);
    if (!message) return;

    // Update the embed to show "ACCEPTED"
    const embed = challengeEmbed(challenge, !!challenge.is_anonymous);
    embed.setTitle(`[ACCEPTED] ${embed.data.title}`);
    embed.setColor(0x2ecc71);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`challenge_accept_${challenge.id}`)
        .setLabel('Accepted')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );

    await message.edit({
      embeds: [embed],
      components: [disabledRow],
    });
  } catch (err) {
    console.error(`[ChallengeAccept] Failed to update board message for challenge #${challenge.id}:`, err.message);
  }
}

module.exports = {
  handleButton,
  handleConfirmedAccept,
  handleTeamConfirmedAccept,
  handleUserSelect,
  handleRemoveTeammate,
  handleAddMoreTeammate,
  handleContinueTeammates,
};
