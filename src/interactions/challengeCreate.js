const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  TEAM_SIZES,
  SERIES_LENGTHS,
  GAME_MODES,
  CHALLENGE_TYPE,
  TIMERS,
  USDC_PER_UNIT,
} = require('../config/constants');
const channelService = require('../services/channelService');
const { t, langFor } = require('../locales/i18n');

// Navigation row — Previous + Cancel on every step. Labels in user's language.
function navRow(step, lang = 'en') {
  const buttons = [];
  if (step > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('wager_prev')
        .setLabel(t('common.previous', lang))
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('wager_cancel_flow')
      .setLabel(t('common.cancel', lang))
      .setStyle(ButtonStyle.Danger),
  );
  return new ActionRowBuilder().addComponents(...buttons);
}
function cancelRow(lang = 'en') { return navRow(1, lang); }

// Track each user's in-progress challenge creation state
// discordUserId -> { type, teamSize, teammates, gameMode, series, anonymous, channelId }
const activeFlows = new Map();
// Prevent double-submit on finalize
const finalizingUsers = new Set();

/**
 * Handle button interactions for challenge creation flow.
 */
async function handleButton(interaction) {
  const id = interaction.customId;
  const userId = interaction.user.id;
  const lang = langFor(interaction);

  // Confirm & Create challenge
  if (id === 'wager_confirm_create') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }
    return finalizeChallengeCreation(interaction, flow, flow.pendingAmount || 0);
  }

  // Previous button — go back one step
  if (id === 'wager_prev') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    let prevStep = flow.step - 1;
    // Skip teammate step for 1v1
    if (prevStep === 2 && flow.teamSize === 1) prevStep = 1;
    if (prevStep < 1) return interaction.reply({ content: t('challenge_create.already_first_step', lang), ephemeral: true });

    // Reconstruct the previous step UI
    if (prevStep === 1) {
      // Team size
      flow.step = 1;
      const row = new ActionRowBuilder().addComponents(
        ...TEAM_SIZES.map(size =>
          new ButtonBuilder().setCustomId(`wager_teamsize_${size}`).setLabel(`${size}v${size}`).setStyle(ButtonStyle.Secondary),
        ),
      );
      const stepKey = flow.type === CHALLENGE_TYPE.WAGER ? 'challenge_create.setting_up_wager' : 'challenge_create.setting_up_xp';
      return interaction.update({ content: t(stepKey, lang), components: [row, navRow(1, lang)] });
    }

    if (prevStep === 2) {
      // Teammate select
      flow.step = 2;
      const selectRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('select_teammates')
          .setPlaceholder(t('challenge_create.select_teammates_placeholder', lang, { count: flow.teamSize - 1 }))
          .setMinValues(flow.teamSize - 1)
          .setMaxValues(flow.teamSize - 1),
      );
      return interaction.update({ content: t('challenge_create.select_teammates_short', lang, { size: flow.teamSize }), components: [selectRow, navRow(2, lang)] });
    }

    if (prevStep === 3) {
      // Game mode — call showGameModes
      return showGameModes(interaction, flow);
    }

    if (prevStep === 4) {
      // Series length
      flow.step = 4;
      const row = new ActionRowBuilder().addComponents(
        ...SERIES_LENGTHS.map(len =>
          new ButtonBuilder().setCustomId(`wager_series_${len}`).setLabel(t('challenge_create.series_label', lang, { n: len })).setStyle(ButtonStyle.Secondary),
        ),
      );
      return interaction.update({ content: t('challenge_create.select_series', lang, { mode: GAME_MODES[flow.gameMode]?.label || flow.gameMode }), components: [row, navRow(4, lang)] });
    }

    return interaction.reply({ content: t('challenge_create.cannot_go_back', lang), ephemeral: true });
  }

  // Cancel challenge creation — delete setup channel
  if (id === 'wager_cancel_create' || id === 'wager_cancel_flow') {
    const flow = activeFlows.get(userId);
    activeFlows.delete(userId);
    finalizingUsers.delete(userId);
    await interaction.update({ content: t('challenge_create.cancelled_msg', lang), embeds: [], components: [] });
    if (flow?.channelId) {
      setTimeout(async () => {
        try {
          const ch = interaction.client.channels.cache.get(flow.channelId);
          if (ch && ch.deletable) await ch.delete('Challenge creation cancelled');
        } catch { /* */ }
      }, 3000);
    }
    return;
  }

  // Step 1: Create Wager or XP Match — create a private channel for this user
  if (id === 'wager_type_wager' || id === 'wager_type_xp') {
    // Check if matches are paused (season transition)
    const { isMatchesPaused } = require('../panels/seasonPanel');
    if (isMatchesPaused()) {
      return interaction.reply({
        content: t('common.matches_paused', lang),
        ephemeral: true,
      });
    }

    // Check if user is registered with a COD UID
    const userRepo = require('../database/repositories/userRepo');
    const dbUser = userRepo.findByDiscordId(userId);
    if (!dbUser || !dbUser.cod_uid) {
      return interaction.reply({
        content: t('common.not_registered', lang),
        ephemeral: true,
      });
    }

    // Check if user is busy (in another challenge or match)
    const { isPlayerBusy } = require('../utils/playerStatus');
    const busy = isPlayerBusy(dbUser.id);
    if (busy.busy) {
      return interaction.reply({ content: busy.reason, ephemeral: true });
    }

    // Check if user already has an active flow
    const existing = activeFlows.get(userId);
    if (existing && existing.channelId) {
      return interaction.reply({
        content: t('common.you_already_have_setup', lang, { channel: `<#${existing.channelId}>` }),
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const type = id === 'wager_type_wager' ? CHALLENGE_TYPE.WAGER : CHALLENGE_TYPE.XP;

    // Create a private channel for this user's setup under the right category
    const guild = interaction.guild;
    let username = interaction.user.username;
    const channelPrefix = type === CHALLENGE_TYPE.WAGER ? 'wager' : 'xp-match';
    const categoryId = type === CHALLENGE_TYPE.WAGER
      ? (process.env.WAGER_SETUP_CATEGORY_ID || null)
      : (process.env.XP_SETUP_CATEGORY_ID || null);
    const channel = await channelService.createPrivateChannel(
      guild,
      `${channelPrefix}-${username}`,
      [userId],
      categoryId,
    );

    activeFlows.set(userId, {
      type,
      step: 1,
      teamSize: null,
      teammates: [],
      gameMode: null,
      series: null,
      anonymous: null,
      channelId: channel.id,
    });

    // Send team size buttons in the private channel
    const row = new ActionRowBuilder().addComponents(
      ...TEAM_SIZES.map(size =>
        new ButtonBuilder()
          .setCustomId(`wager_teamsize_${size}`)
          .setLabel(`${size}v${size}`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    const typeLabel = type === CHALLENGE_TYPE.WAGER
      ? t('challenge_create.type_wager', lang)
      : t('challenge_create.type_xp_match', lang);
    const introKey = type === CHALLENGE_TYPE.WAGER
      ? 'challenge_create.setting_up_wager'
      : 'challenge_create.setting_up_xp';
    await channel.send({
      content: `<@${userId}> ${t(introKey, lang)}`,
      components: [row, cancelRow(lang)],
    });

    await interaction.editReply({
      content: t('challenge_create.setup_channel_created', lang, { type: typeLabel.toLowerCase(), channel: `<#${channel.id}>` }),
    });
    return;
  }

  // Step 2: Team size selection
  if (id.startsWith('wager_teamsize_')) {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    const teamSize = parseInt(id.split('_')[2], 10);
    flow.teamSize = teamSize;

    // For team sizes > 1, show teammate select menu
    if (teamSize > 1) {
      const selectRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('select_teammates')
          .setPlaceholder(t('challenge_create.select_teammates_placeholder', lang, { count: teamSize - 1 }))
          .setMinValues(teamSize - 1)
          .setMaxValues(teamSize - 1),
      );

      flow.step = 2;
      return interaction.update({
        content: t('challenge_create.select_teammates', lang, { size: teamSize, count: teamSize - 1 }),
        components: [selectRow, navRow(2, lang)],
      });
    }

    // For 1v1, skip to game mode selection
    flow.teammates = [];
    return showGameModes(interaction, flow);
  }

  // Step 4: Game mode selection
  if (id.startsWith('wager_mode_')) {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    const mode = id.replace('wager_mode_', '');
    flow.gameMode = mode;

    // Show series length buttons
    const row = new ActionRowBuilder().addComponents(
      ...SERIES_LENGTHS.map(len =>
        new ButtonBuilder()
          .setCustomId(`wager_series_${len}`)
          .setLabel(t('challenge_create.series_label', lang, { n: len }))
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    flow.step = 4;
    return interaction.update({
      content: t('challenge_create.select_series', lang, { mode: GAME_MODES[mode]?.label || mode }),
      components: [row, navRow(4, lang)],
    });
  }

  // Step 5: Series length selection
  if (id.startsWith('wager_series_')) {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    const series = parseInt(id.split('_')[2], 10);
    flow.series = series;

    // Show visibility options
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wager_vis_anon')
        .setLabel(t('challenge_create.btn_anonymous', lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('wager_vis_named')
        .setLabel(t('challenge_create.btn_show_names', lang))
        .setStyle(ButtonStyle.Primary),
    );

    return interaction.update({
      content: [
        t('challenge_create.visibility_title', lang),
        '',
        `${t('challenge_create.confirm_field_series', lang)}: **${t('challenge_create.series_label', lang, { n: series })}**`,
        '',
        t('challenge_create.visibility_anon_desc', lang),
        '',
        t('challenge_create.visibility_named_desc', lang),
      ].join('\n'),
      components: [row, navRow(5, lang)],
    });
    flow.step = 5;
  }

  // Step 6: Visibility selection
  if (id === 'wager_vis_anon' || id === 'wager_vis_named') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    flow.anonymous = id === 'wager_vis_anon';

    if (flow.type === CHALLENGE_TYPE.WAGER) {
      // Show entry amount modal for wagers in user's language
      const modal = new ModalBuilder()
        .setCustomId('entry_amount')
        .setTitle(t('challenge_create.entry_modal_title', lang));

      const amountInput = new TextInputBuilder()
        .setCustomId('amount_input')
        .setLabel(t('challenge_create.entry_modal_label', lang))
        .setPlaceholder(t('challenge_create.entry_modal_placeholder', lang))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(10);

      const amountRow = new ActionRowBuilder().addComponents(amountInput);
      modal.addComponents(amountRow);

      return interaction.showModal(modal);
    }

    // XP match — show confirmation before creating
    return showChallengeConfirm(interaction, flow, 0);
  }
}

/**
 * Handle modal submissions for challenge creation.
 */
async function handleModal(interaction) {
  const userId = interaction.user.id;
  const lang = langFor(interaction);
  const flow = activeFlows.get(userId);
  if (!flow) {
    await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
  }

  if (interaction.customId === 'entry_amount') {
    const amountStr = interaction.fields.getTextInputValue('amount_input').trim();
    const amount = parseFloat(amountStr);

    const minWager = Number(process.env.MIN_WAGER_USDC || 1);
    const maxWager = Number(process.env.MAX_WAGER_USDC || 1000);

    if (isNaN(amount) || amount < minWager || amount > maxWager) {
      return interaction.reply({
        content: t('challenge_create.invalid_amount', lang, { min: minWager, max: maxWager }),
        ephemeral: true,
      });
    }

    return showChallengeConfirm(interaction, flow, amount);
  }
}

/**
 * Handle user select menu interactions (teammate selection).
 */
async function handleUserSelect(interaction) {
  const userId = interaction.user.id;
  const lang = langFor(interaction);
  const flow = activeFlows.get(userId);
  if (!flow) {
    await interaction.reply({ content: t('common.session_expired', lang), ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
  }

  if (interaction.customId === 'select_teammates') {
    const selectedUsers = interaction.values;

    // Check each teammate is registered and not busy
    const userRepo = require('../database/repositories/userRepo');
    const { isPlayerBusy } = require('../utils/playerStatus');
    for (const teammateDiscordId of selectedUsers) {
      const tmUser = userRepo.findByDiscordId(teammateDiscordId);
      if (!tmUser || !tmUser.cod_uid) {
        return interaction.reply({ content: t('common.teammate_not_registered', lang, { user: `<@${teammateDiscordId}>` }), ephemeral: true });
      }
      const busy = isPlayerBusy(tmUser.id);
      if (busy.busy) {
        return interaction.reply({ content: t('common.teammate_busy', lang, { user: `<@${teammateDiscordId}>`, reason: busy.reason }), ephemeral: true });
      }
    }

    flow.teammates = selectedUsers;
    return showGameModes(interaction, flow);
  }
}

/**
 * Show challenge summary and confirm before creating.
 */
async function showChallengeConfirm(interaction, flow, amountUsdc) {
  const userId = interaction.user.id;
  const lang = langFor(interaction);
  flow.pendingAmount = amountUsdc; // store for after confirmation

  const modeLabel = GAME_MODES[flow.gameMode]?.label || flow.gameMode;
  const typeLabel = flow.type === CHALLENGE_TYPE.WAGER
    ? t('challenge_create.type_wager', lang)
    : t('challenge_create.type_xp_match', lang);
  const entryText = flow.type === CHALLENGE_TYPE.WAGER && amountUsdc > 0
    ? `**${t('challenge_create.confirm_field_entry', lang)}:** ${t('challenge_create.confirm_entry_format', lang, { amount: amountUsdc })}\n**${t('challenge_create.confirm_field_pot', lang)}:** ${t('challenge_create.confirm_pot_format', lang, { amount: amountUsdc * flow.teamSize * 2 })}`
    : `**${t('challenge_create.confirm_field_entry', lang)}:** ${t('challenge_create.confirm_no_entry', lang)}`;
  const teammateText = flow.teammates.length > 0
    ? `**${t('challenge_create.confirm_field_teammates', lang)}:** ${flow.teammates.map(id => `<@${id}>`).join(', ')}`
    : '';

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const visibilityLabel = flow.anonymous
    ? t('challenge_create.visibility_anonymous', lang)
    : t('challenge_create.visibility_named', lang);

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('challenge_create.confirm_title', lang))
    .setColor(0xf1c40f)
    .setDescription([
      `**${t('challenge_create.confirm_field_type', lang)}:** ${typeLabel}`,
      `**${t('challenge_create.confirm_field_team_size', lang)}:** ${flow.teamSize}v${flow.teamSize}`,
      `**${t('challenge_create.confirm_field_mode', lang)}:** ${modeLabel}`,
      `**${t('challenge_create.confirm_field_series', lang)}:** ${t('challenge_create.series_label', lang, { n: flow.series })}`,
      `**${t('challenge_create.confirm_field_visibility', lang)}:** ${visibilityLabel}`,
      entryText,
      teammateText,
      '',
    ].filter(Boolean).join('\n'));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_confirm_create')
      .setLabel(t('challenge_create.btn_confirm_create', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wager_cancel_create')
      .setLabel(t('challenge_create.btn_cancel_create', lang))
      .setStyle(ButtonStyle.Danger),
  );

  if (interaction.isModalSubmit()) {
    return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow] });
  }
  return interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
}

/**
 * Show game mode selection buttons.
 */
async function showGameModes(interaction, flow) {
  const lang = langFor(interaction);
  const modeKeys = Object.keys(GAME_MODES);

  // Split into rows of 4 (Discord max 5 buttons per row)
  const rows = [];
  for (let i = 0; i < modeKeys.length; i += 4) {
    const chunk = modeKeys.slice(i, i + 4);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map(key =>
        new ButtonBuilder()
          .setCustomId(`wager_mode_${key}`)
          .setLabel(GAME_MODES[key].label)
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    rows.push(row);
  }

  flow.step = 3;
  rows.push(navRow(3, lang));

  const content = flow.teammates.length > 0
    ? t('challenge_create.select_game_mode_with_teammates', lang, {
        size: flow.teamSize,
        teammates: flow.teammates.map(id => `<@${id}>`).join(', '),
      })
    : t('challenge_create.select_game_mode', lang, { size: flow.teamSize });

  return interaction.update({ content, components: rows });
}

/**
 * Finalize challenge creation — validate, hold funds, create in DB, post to board.
 * Then delete the setup channel.
 */
async function finalizeChallengeCreation(interaction, flow, amountUsdc) {
  const userId = interaction.user.id;
  const lang = langFor(interaction);

  // Prevent double-submit
  if (finalizingUsers.has(userId)) {
    return interaction.reply ? interaction.reply({ content: t('challenge_create.already_processing', lang), ephemeral: true }) : null;
  }
  finalizingUsers.add(userId);

  // Defer the response
  if (interaction.isModalSubmit()) {
    await interaction.deferReply();
  } else {
    await interaction.deferUpdate();
  }

  try {
    const userRepo = require('../database/repositories/userRepo');
    const challengeRepo = require('../database/repositories/challengeRepo');
    const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
    const escrowManager = require('../solana/escrowManager');
    const { CHALLENGE_STATUS, PLAYER_ROLE, PLAYER_STATUS } = require('../config/constants');

    const user = userRepo.findByDiscordId(userId);
    if (!user) {
      return sendFlowReply(interaction, t('common.onboarding_required', lang));
    }

    const entryUsdc = Math.floor(amountUsdc * USDC_PER_UNIT);
    const totalPotUsdc = entryUsdc * flow.teamSize * 2;

    const expiresAt = new Date(Date.now() + TIMERS.CHALLENGE_EXPIRY).toISOString();

    const initialStatus = flow.teammates.length > 0
      ? CHALLENGE_STATUS.PENDING_TEAMMATES
      : CHALLENGE_STATUS.OPEN;

    const challenge = challengeRepo.create({
      type: flow.type,
      creatorUserId: user.id,
      teamSize: flow.teamSize,
      gameModes: flow.gameMode,
      seriesLength: flow.series,
      entryAmountUsdc: entryUsdc.toString(),
      totalPotUsdc: totalPotUsdc.toString(),
      isAnonymous: flow.anonymous ? 1 : 0,
      expiresAt,
    });

    // For wager type, validate and hold creator's funds
    if (flow.type === CHALLENGE_TYPE.WAGER && entryUsdc > 0) {
      if (!escrowManager.canAfford(user.id, entryUsdc.toString())) {
        challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.CANCELLED);
        await cleanupFlowChannel(interaction.client, flow, userId);
        return sendFlowReply(interaction, t('challenge_create.insufficient_create', lang, { amount: amountUsdc }));
      }

      const held = escrowManager.holdFunds(user.id, entryUsdc.toString(), challenge.id);
      if (!held) {
        challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.CANCELLED);
        await cleanupFlowChannel(interaction.client, flow, userId);
        return sendFlowReply(interaction, t('challenge_create.failed_hold_funds', lang));
      }
    }

    // Add creator as team 1 captain
    challengePlayerRepo.create({
      challengeId: challenge.id,
      userId: user.id,
      team: 1,
      role: PLAYER_ROLE.CAPTAIN,
      status: PLAYER_STATUS.ACCEPTED,
      fundsHeld: (flow.type === CHALLENGE_TYPE.WAGER && entryUsdc > 0) ? 1 : 0,
    });

    // Add teammates as pending team 1 players
    for (const teammateDiscordId of flow.teammates) {
      const teammateUser = userRepo.findByDiscordId(teammateDiscordId);
      if (teammateUser) {
        challengePlayerRepo.create({
          challengeId: challenge.id,
          userId: teammateUser.id,
          team: 1,
          role: PLAYER_ROLE.PLAYER,
          status: PLAYER_STATUS.PENDING,
        });
      }
    }

    if (initialStatus === CHALLENGE_STATUS.OPEN) {
      challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.OPEN);
    }

    // Trigger teammate notifications or post to board
    const challengeService = require('../services/challengeService');
    if (flow.teammates.length > 0) {
      challengeService.notifyTeammates(interaction.guild, challenge).catch(err => {
        console.error('[ChallengeCreate] Error notifying teammates:', err);
      });
    } else {
      challengeService.postToBoard(interaction.client, challenge).catch(err => {
        console.error('[ChallengeCreate] Error posting to board:', err);
      });
    }

    // Build summary in user's language
    const modeLabel = GAME_MODES[flow.gameMode]?.label || flow.gameMode;
    const isWager = flow.type === CHALLENGE_TYPE.WAGER;
    const typeLabel = isWager ? t('challenge_create.type_wager', lang) : t('challenge_create.type_xp_match', lang);
    const entryText = isWager
      ? `\n${t('challenge_create.confirm_field_entry', lang)}: **${t('challenge_create.confirm_entry_format', lang, { amount: amountUsdc })}**`
      : `\n${t('challenge_create.confirm_field_type', lang)}: **${typeLabel}** (${t('challenge_create.confirm_no_entry', lang)})`;

    // Log to admin transaction feed (English — admin-only)
    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'challenge_created',
      username: user.server_username,
      discordId: userId,
      challengeId: challenge.id,
      memo: `${isWager ? 'Wager' : 'XP Match'} | ${flow.teamSize}v${flow.teamSize} | ${modeLabel} | Bo${flow.series}${isWager ? ` | $${amountUsdc} entry` : ''}`,
    });

    const visibilityLabel = flow.anonymous
      ? t('challenge_create.visibility_anonymous', lang)
      : t('challenge_create.visibility_named', lang);

    const summary = [
      t('challenge_create.create_summary_header', lang, { type: typeLabel, num: challenge.display_number || challenge.id }),
      '',
      `${t('challenge_create.confirm_field_type', lang)}: **${typeLabel}**`,
      `${t('challenge_create.confirm_field_team_size', lang)}: **${flow.teamSize}v${flow.teamSize}**`,
      `${t('challenge_create.confirm_field_mode', lang)}: **${modeLabel}**`,
      `${t('challenge_create.confirm_field_series', lang)}: **${t('challenge_create.series_label', lang, { n: flow.series })}**`,
      `${t('challenge_create.confirm_field_visibility', lang)}: **${visibilityLabel}**`,
      entryText,
      '',
      flow.teammates.length > 0
        ? t('challenge_create.create_summary_waiting_teammates', lang)
        : t('challenge_create.create_summary_live_board', lang),
      '',
      t('challenge_create.create_summary_delete_notice', lang),
    ].join('\n');

    await sendFlowReply(interaction, summary);
    finalizingUsers.delete(userId);

    // Delete the setup channel after a short delay
    await cleanupFlowChannel(interaction.client, flow, userId, 10000);
  } catch (err) {
    console.error('[ChallengeCreate] Error finalizing challenge:', err);
    finalizingUsers.delete(userId);
    await cleanupFlowChannel(interaction.client, activeFlows.get(userId), userId);
    return sendFlowReply(interaction, t('challenge_create.error_creating', lang));
  }
}

/**
 * Clean up the private setup channel and remove the flow from activeFlows.
 */
async function cleanupFlowChannel(client, flow, userId, delayMs = 5000) {
  if (!flow) {
    activeFlows.delete(userId);
    return;
  }

  const channelId = flow.channelId;
  activeFlows.delete(userId);

  if (channelId) {
    setTimeout(async () => {
      try {
        const channel = client.channels.cache.get(channelId);
        if (channel && channel.deletable) {
          await channel.delete('Wager setup complete');
        }
      } catch {
        // Channel may already be deleted
      }
    }, delayMs);
  }
}

/**
 * Send a reply depending on the interaction state.
 */
async function sendFlowReply(interaction, content) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content, components: [] });
  }
  return interaction.reply({ content });
}

module.exports = { handleButton, handleModal, handleUserSelect };
