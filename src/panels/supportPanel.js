// Support ticket panel — single embed + category dropdown posted in
// SUPPORT_CHANNEL_ID. Selecting a category creates a private channel
// under TICKETS_CATEGORY_ID for the user + the relevant staff roles.
//
// Only one panel ever lives in the support channel — postSupportPanel
// (called on boot) scans for an existing bot panel and edits in-place
// rather than spamming a new message every restart.

const {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');

const userRepo = require('../database/repositories/userRepo');
const ticketRepo = require('../database/repositories/ticketRepo');

// Categories shown on the dropdown. Each entry routes the new ticket
// channel to a specific subset of staff roles (read from env). Adding
// a new category = add a row here, no other changes needed.
const TICKET_CATEGORIES = {
  wallet: {
    label: 'Wallet / Payment',
    emoji: '💰',
    description: 'Deposit didn\'t show up, withdraw stuck, balance wrong',
    staffRoleEnvVars: ['ADMIN_ROLE_ID', 'OWNER_ROLE_ID', 'CEO_ROLE_ID', 'ADS_ROLE_ID'],
    pingRoleEnvVar: 'ADMIN_ROLE_ID',
  },
  match_dispute: {
    label: 'Match Dispute',
    emoji: '⚔️',
    description: 'Post-match issue (not the live in-match dispute button)',
    staffRoleEnvVars: ['WAGER_STAFF_ROLE_ID', 'ADMIN_ROLE_ID', 'OWNER_ROLE_ID', 'CEO_ROLE_ID', 'ADS_ROLE_ID'],
    pingRoleEnvVar: 'WAGER_STAFF_ROLE_ID',
  },
  player_report: {
    label: 'Report a Player',
    emoji: '🚨',
    description: 'Cheater, griefer, or unsporting conduct',
    staffRoleEnvVars: ['WAGER_STAFF_ROLE_ID', 'XP_STAFF_ROLE_ID', 'ADMIN_ROLE_ID', 'OWNER_ROLE_ID', 'CEO_ROLE_ID', 'ADS_ROLE_ID'],
    pingRoleEnvVar: 'WAGER_STAFF_ROLE_ID',
  },
  general: {
    label: 'General Help',
    emoji: '❓',
    description: 'Questions about the platform or anything else',
    staffRoleEnvVars: ['WAGER_STAFF_ROLE_ID', 'XP_STAFF_ROLE_ID', 'ADMIN_ROLE_ID', 'OWNER_ROLE_ID', 'CEO_ROLE_ID', 'ADS_ROLE_ID'],
    pingRoleEnvVar: 'WAGER_STAFF_ROLE_ID',
  },
  partnerships: {
    label: 'Partnerships / Business',
    emoji: '🤝',
    description: 'Sponsorship, content creator program, integrations',
    staffRoleEnvVars: ['ADMIN_ROLE_ID', 'OWNER_ROLE_ID', 'CEO_ROLE_ID'],
    pingRoleEnvVar: 'CEO_ROLE_ID',
  },
};

const MAX_OPEN_TICKETS_PER_USER = 3;

function _buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Support Tickets')
    .setColor(0x3498db)
    .setDescription([
      'Need help? Pick a category below and a private support channel will be created for you.',
      '',
      'Only you and the relevant staff will see your ticket. Close it any time with the **Close Ticket** button — tickets also auto-close after 7 days of inactivity.',
    ].join('\n'));

  const select = new StringSelectMenuBuilder()
    .setCustomId('support_open_ticket')
    .setPlaceholder('Pick what you need help with')
    .addOptions(Object.entries(TICKET_CATEGORIES).map(([key, cat]) => ({
      label: cat.label,
      description: cat.description,
      value: key,
      emoji: cat.emoji,
    })));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] };
}

/**
 * Post (or refresh in place) the support panel on boot. Idempotent —
 * if a panel already exists in the channel, edit it; otherwise post fresh.
 */
async function postSupportPanel(client) {
  const channelId = process.env.SUPPORT_CHANNEL_ID;
  if (!channelId) {
    console.warn('[SupportPanel] SUPPORT_CHANNEL_ID not set — skipping panel post');
    return;
  }
  const channel = client.channels.cache.get(channelId)
    || await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.error(`[SupportPanel] Channel ${channelId} unreachable`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const existing = messages.find(m =>
      m.author.id === client.user.id
      && m.embeds[0]?.title === '🎫 Support Tickets',
    );
    if (existing) {
      await existing.edit(_buildPanel());
      console.log('[SupportPanel] Refreshed existing panel');
    } else {
      await channel.send(_buildPanel());
      console.log('[SupportPanel] Posted new panel');
    }
  } catch (err) {
    console.error('[SupportPanel] Failed to post/refresh panel:', err.message);
  }
}

/**
 * Handle the support_open_ticket category dropdown selection. Creates
 * a private ticket channel and inserts a row in the tickets table.
 */
async function handleCategorySelect(interaction) {
  const categoryKey = interaction.values?.[0];
  const category = TICKET_CATEGORIES[categoryKey];
  if (!category) {
    return interaction.reply({ content: 'Unknown category.', ephemeral: true });
  }

  const discordId = interaction.user.id;
  const dbUser = userRepo.findByDiscordId(discordId);
  if (!dbUser || !dbUser.accepted_tos) {
    return interaction.reply({
      content: 'Register first in the welcome channel before opening a ticket.',
      ephemeral: true,
    });
  }

  // Reject if already at the open-ticket cap. Stops a single user from
  // spamming the staff queue with tickets.
  const openTickets = ticketRepo.findOpenByUser(dbUser.id);
  if (openTickets.length >= MAX_OPEN_TICKETS_PER_USER) {
    return interaction.reply({
      content: `You already have ${openTickets.length} open tickets. Close one before opening another.`,
      ephemeral: true,
    });
  }
  // Same-category collision — point them at the existing channel.
  const sameCategory = ticketRepo.findOpenByUserAndCategory(dbUser.id, categoryKey);
  if (sameCategory) {
    return interaction.reply({
      content: `You already have an open ${category.label} ticket: <#${sameCategory.channel_id}>`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  // Resolve the staff role IDs for this category. Filter out any that
  // aren't set in env so a missing role doesn't crash channel creation.
  const staffRoleIds = category.staffRoleEnvVars
    .map(v => process.env[v])
    .filter(Boolean);
  const pingRoleId = process.env[category.pingRoleEnvVar] || staffRoleIds[0] || null;

  // Build permission overwrites: deny @everyone, allow user + bot +
  // staff. Staff can ViewChannel + SendMessages + ManageMessages so
  // they can pin / clean up if needed.
  const guild = interaction.guild;
  const overwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: discordId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    ...staffRoleIds.map(roleId => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages,
      ],
    })),
  ];

  // Create channel under the tickets category if configured.
  let channel;
  try {
    channel = await guild.channels.create({
      name: `ticket-${dbUser.server_username || discordId}-${categoryKey}`.toLowerCase().slice(0, 80),
      type: ChannelType.GuildText,
      parent: process.env.TICKETS_CATEGORY_ID || null,
      permissionOverwrites: overwrites,
      reason: `Ticket: ${category.label} for ${discordId}`,
    });
  } catch (err) {
    console.error('[SupportPanel] Channel create failed:', err.message);
    return interaction.editReply({
      content: 'Could not create your ticket channel. An admin needs to verify the bot has the Manage Channels permission and that TICKETS_CATEGORY_ID is set.',
    });
  }

  // Persist + arm the inactivity timer.
  let ticket;
  try {
    ticket = ticketRepo.create({
      userId: dbUser.id,
      category: categoryKey,
      channelId: channel.id,
    });
    const timerService = require('../services/timerService');
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    timerService.createTimer('ticket_inactivity', ticket.id, SEVEN_DAYS_MS);
  } catch (err) {
    console.error('[SupportPanel] DB insert / timer create failed:', err.message);
    // Roll back the Discord channel so we don't leak orphan channels.
    try { await channel.delete('Ticket DB insert failed'); } catch { /* */ }
    return interaction.editReply({
      content: 'Could not create your ticket. Try again in a moment.',
    });
  }

  // Opening message inside the ticket channel — pings the relevant
  // staff role and tells the user what to do next.
  const openEmbed = new EmbedBuilder()
    .setTitle(`${category.emoji} ${category.label} — Ticket #${ticket.id}`)
    .setColor(0x3498db)
    .setDescription([
      `Hey <@${discordId}> — describe your issue below.`,
      '',
      `Include any relevant details: match numbers, screenshots, transaction hashes, usernames, etc. The more context, the faster staff can help.`,
      '',
      'Close this ticket any time with the button below. It will also auto-close after 7 days of inactivity.',
    ].join('\n'));

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_close_${ticket.id}`)
      .setLabel('Close Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );

  const pingPrefix = pingRoleId ? `<@&${pingRoleId}> ` : '';
  await channel.send({
    content: `${pingPrefix}— new ${category.label.toLowerCase()} ticket from <@${discordId}>`,
    embeds: [openEmbed],
    components: [closeRow],
    allowedMentions: { roles: pingRoleId ? [pingRoleId] : [], users: [discordId] },
  });

  // Tell the user where their ticket is.
  return interaction.editReply({
    content: `Opened your ticket: <#${channel.id}>`,
  });
}

module.exports = {
  postSupportPanel,
  handleCategorySelect,
  TICKET_CATEGORIES,
  MAX_OPEN_TICKETS_PER_USER,
};
