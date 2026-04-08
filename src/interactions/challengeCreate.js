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

// Navigation row — Previous + Cancel on every step
function navRow(step) {
  const buttons = [];
  if (step > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId('wager_prev')
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId('wager_cancel_flow')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
  return new ActionRowBuilder().addComponents(...buttons);
}
function cancelRow() { return navRow(1); }

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

  // Confirm & Create challenge
  if (id === 'wager_confirm_create') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }
    return finalizeChallengeCreation(interaction, flow, flow.pendingAmount || 0);
  }

  // Previous button — go back one step
  if (id === 'wager_prev') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    let prevStep = flow.step - 1;
    // Skip teammate step for 1v1
    if (prevStep === 2 && flow.teamSize === 1) prevStep = 1;
    if (prevStep < 1) return interaction.reply({ content: 'Already at the first step.', ephemeral: true });

    // Reconstruct the previous step UI
    if (prevStep === 1) {
      // Team size
      flow.step = 1;
      const row = new ActionRowBuilder().addComponents(
        ...TEAM_SIZES.map(size =>
          new ButtonBuilder().setCustomId(`wager_teamsize_${size}`).setLabel(`${size}v${size}`).setStyle(ButtonStyle.Secondary),
        ),
      );
      const typeLabel = flow.type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match';
      return interaction.update({ content: `**Setting up ${typeLabel}**\n\n**Select team size:**`, components: [row, navRow(1)] });
    }

    if (prevStep === 2) {
      // Teammate select
      flow.step = 2;
      const selectRow = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('select_teammates')
          .setPlaceholder(`Select ${flow.teamSize - 1} teammate(s)`)
          .setMinValues(flow.teamSize - 1)
          .setMaxValues(flow.teamSize - 1),
      );
      return interaction.update({ content: `**Select your teammates:**\n\nTeam size: **${flow.teamSize}v${flow.teamSize}**`, components: [selectRow, navRow(2)] });
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
          new ButtonBuilder().setCustomId(`wager_series_${len}`).setLabel(`Best of ${len}`).setStyle(ButtonStyle.Secondary),
        ),
      );
      return interaction.update({ content: `**Select series length:**\n\nMode: **${GAME_MODES[flow.gameMode]?.label || flow.gameMode}**`, components: [row, navRow(4)] });
    }

    return interaction.reply({ content: 'Cannot go back further.', ephemeral: true });
  }

  // Cancel challenge creation — delete setup channel
  if (id === 'wager_cancel_create' || id === 'wager_cancel_flow') {
    const flow = activeFlows.get(userId);
    activeFlows.delete(userId);
    finalizingUsers.delete(userId);
    await interaction.update({ content: 'Challenge creation cancelled. This channel will be deleted.', embeds: [], components: [] });
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
        content: 'Match creation is currently paused for a season transition. Please wait for the new season to begin.',
        ephemeral: true,
      });
    }

    // Check if user is registered with a COD UID
    const userRepo = require('../database/repositories/userRepo');
    const dbUser = userRepo.findByDiscordId(userId);
    if (!dbUser || !dbUser.cod_uid) {
      return interaction.reply({
        content: 'You must complete registration with your COD Mobile UID before creating challenges.',
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
        content: `You already have a wager setup in progress. Check <#${existing.channelId}>.`,
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

    const typeLabel = type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match';
    await channel.send({
      content: `<@${userId}> **Setting up ${typeLabel}**\n\n**Select team size:**`,
      components: [row, cancelRow()],
    });

    await interaction.editReply({
      content: `Your ${typeLabel.toLowerCase()} setup channel has been created: <#${channel.id}>`,
    });
    // Auto-delete this ephemeral message after 30 seconds
    setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 30000);
    return;
  }

  // Step 2: Team size selection
  if (id.startsWith('wager_teamsize_')) {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
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
          .setPlaceholder(`Select ${teamSize - 1} teammate(s)`)
          .setMinValues(teamSize - 1)
          .setMaxValues(teamSize - 1),
      );

      flow.step = 2;
      return interaction.update({
        content: `**Select your teammates:**\n\nTeam size: **${teamSize}v${teamSize}** — Pick **${teamSize - 1}** teammate(s).`,
        components: [selectRow, navRow(2)],
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
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
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
          .setLabel(`Best of ${len}`)
          .setStyle(ButtonStyle.Secondary),
      ),
    );

    flow.step = 4;
    return interaction.update({
      content: `**Select series length:**\n\nMode: **${GAME_MODES[mode]?.label || mode}**`,
      components: [row, navRow(4)],
    });
  }

  // Step 5: Series length selection
  if (id.startsWith('wager_series_')) {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    const series = parseInt(id.split('_')[2], 10);
    flow.series = series;

    // Show visibility options
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wager_vis_anon')
        .setLabel('Anonymous')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('wager_vis_named')
        .setLabel('Show My Name')
        .setStyle(ButtonStyle.Primary),
    );

    return interaction.update({
      content: [
        '**Challenge visibility:**',
        '',
        `Series: **Best of ${series}**`,
        '',
        '**Anonymous** — Your name and teammates will be hidden on the challenge board. Opponents won\'t know who they\'re facing until they accept.',
        '',
        '**Show Names** — Your name and teammates will be visible on the challenge board so opponents can see who\'s challenging.',
      ].join('\n'),
      components: [row, navRow(5)],
    });
    flow.step = 5;
  }

  // Step 6: Visibility selection
  if (id === 'wager_vis_anon' || id === 'wager_vis_named') {
    const flow = activeFlows.get(userId);
    if (!flow) {
      await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
      setTimeout(async () => { try { if (interaction.channel?.deletable) await interaction.channel.delete(); } catch { /* */ } }, 3000);
      return;
    }

    flow.anonymous = id === 'wager_vis_anon';

    if (flow.type === CHALLENGE_TYPE.WAGER) {
      // Show entry amount modal for wagers
      const modal = new ModalBuilder()
        .setCustomId('entry_amount')
        .setTitle('Set Wager Amount');

      const amountInput = new TextInputBuilder()
        .setCustomId('amount_input')
        .setLabel('Entry amount per player (in USDC)')
        .setPlaceholder('e.g. 10')
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
  const flow = activeFlows.get(userId);
  if (!flow) {
    await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
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
        content: `Invalid amount. Wager must be between **$${minWager}** and **$${maxWager}** USDC.`,
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
  const flow = activeFlows.get(userId);
  if (!flow) {
    await interaction.reply({ content: 'Session expired. This channel will be deleted.', ephemeral: true });
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
        return interaction.reply({ content: `<@${teammateDiscordId}> is not registered. They must register before joining a challenge.`, ephemeral: true });
      }
      const busy = isPlayerBusy(tmUser.id);
      if (busy.busy) {
        return interaction.reply({ content: `<@${teammateDiscordId}> is currently busy: ${busy.reason}`, ephemeral: true });
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
  flow.pendingAmount = amountUsdc; // store for after confirmation

  const modeLabel = GAME_MODES[flow.gameMode]?.label || flow.gameMode;
  const typeLabel = flow.type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match';
  const entryText = flow.type === CHALLENGE_TYPE.WAGER && amountUsdc > 0
    ? `**Entry:** $${amountUsdc} USDC per player\n**Total Pot:** $${amountUsdc * flow.teamSize * 2} USDC`
    : '**Entry:** None (XP Match)';
  const teammateText = flow.teammates.length > 0
    ? `**Teammates:** ${flow.teammates.map(id => `<@${id}>`).join(', ')}`
    : '';

  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm & Create Challenge')
    .setColor(0xf1c40f)
    .setDescription([
      `**Type:** ${typeLabel}`,
      `**Team Size:** ${flow.teamSize}v${flow.teamSize}`,
      `**Mode:** ${modeLabel}`,
      `**Series:** Best of ${flow.series}`,
      `**Visibility:** ${flow.anonymous ? 'Anonymous' : 'Show Names'}`,
      entryText,
      teammateText,
      '',
    ].filter(Boolean).join('\n'));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_confirm_create')
      .setLabel('Confirm & Create')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wager_cancel_create')
      .setLabel('Cancel')
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

  const teammateText = flow.teammates.length > 0
    ? `\nTeammates: ${flow.teammates.map(id => `<@${id}>`).join(', ')}`
    : '';

  flow.step = 3;
  rows.push(navRow(3));
  return interaction.update({
    content: `**Select game mode:**\n\nTeam size: **${flow.teamSize}v${flow.teamSize}**${teammateText}`,
    components: rows,
  });
}

/**
 * Finalize challenge creation — validate, hold funds, create in DB, post to board.
 * Then delete the setup channel.
 */
async function finalizeChallengeCreation(interaction, flow, amountUsdc) {
  const userId = interaction.user.id;

  // Prevent double-submit
  if (finalizingUsers.has(userId)) {
    return interaction.reply ? interaction.reply({ content: 'Already processing your challenge...', ephemeral: true }) : null;
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
      return sendFlowReply(interaction, 'You need to complete onboarding first.');
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
        return sendFlowReply(interaction, `Insufficient balance. You need **$${amountUsdc} USDC** to create this wager.`);
      }

      const held = escrowManager.holdFunds(user.id, entryUsdc.toString(), challenge.id);
      if (!held) {
        challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.CANCELLED);
        await cleanupFlowChannel(interaction.client, flow, userId);
        return sendFlowReply(interaction, 'Failed to hold funds. Please try again.');
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

    // Build summary
    const modeLabel = GAME_MODES[flow.gameMode]?.label || flow.gameMode;
    const entryText = flow.type === CHALLENGE_TYPE.WAGER
      ? `\nEntry: **$${amountUsdc} USDC** per player`
      : '\nType: **XP Match** (no wager)';

    // Log to admin transaction feed
    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'challenge_created',
      username: user.server_username,
      discordId: userId,
      challengeId: challenge.id,
      memo: `${flow.type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match'} | ${flow.teamSize}v${flow.teamSize} | ${modeLabel} | Bo${flow.series}${flow.type === CHALLENGE_TYPE.WAGER ? ` | $${amountUsdc} entry` : ''}`,
    });

    const summary = [
      `**${flow.type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match'} #${challenge.display_number || challenge.id} created!**`,
      '',
      `Type: **${flow.type === CHALLENGE_TYPE.WAGER ? 'Wager' : 'XP Match'}**`,
      `Team size: **${flow.teamSize}v${flow.teamSize}**`,
      `Mode: **${modeLabel}**`,
      `Series: **Best of ${flow.series}**`,
      `Visibility: **${flow.anonymous ? 'Anonymous' : 'Named'}**`,
      entryText,
      '',
      flow.teammates.length > 0
        ? 'Your teammates have been notified. Waiting for them to accept.'
        : 'Your challenge is live on the board! Waiting for an opponent.',
      '',
      'This channel will be deleted in 10 seconds.',
    ].join('\n');

    await sendFlowReply(interaction, summary);
    finalizingUsers.delete(userId);

    // Delete the setup channel after a short delay
    await cleanupFlowChannel(interaction.client, flow, userId, 10000);
  } catch (err) {
    console.error('[ChallengeCreate] Error finalizing challenge:', err);
    finalizingUsers.delete(userId);
    await cleanupFlowChannel(interaction.client, activeFlows.get(userId), userId);
    return sendFlowReply(interaction, 'Something went wrong creating your challenge. Please try again.');
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
