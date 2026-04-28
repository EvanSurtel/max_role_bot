// Handle the "Close Ticket" button + the auto-close timer path.
// Both call _closeTicket; the only difference is the closing-actor
// label and which final message gets posted in the ticket channel
// before deletion.
//
// Close flow:
//   1. atomicStatusTransition tickets.status: 'open' -> 'closed' / 'auto_closed'
//      (silently exits if already closed — defends against double-clicks)
//   2. Build a plain-text transcript by paginating channel.messages.fetch
//   3. Post transcript embed + .txt attachment in TICKET_LOGS_CHANNEL_ID
//      (best effort — logs absence shouldn't block channel deletion)
//   4. Tell the channel it's closing in 60 seconds
//   5. Delete the channel after 60 seconds

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const ticketRepo = require('../database/repositories/ticketRepo');
const userRepo = require('../database/repositories/userRepo');
const timerService = require('../services/timerService');
const { TICKET_CATEGORIES } = require('../panels/supportPanel');

const CHANNEL_DELETE_DELAY_MS = 60 * 1000;

async function handleCloseButton(interaction) {
  const ticketId = parseInt(interaction.customId.replace('ticket_close_', ''), 10);
  if (isNaN(ticketId)) {
    return interaction.reply({ content: 'Invalid ticket.', ephemeral: true });
  }

  const ticket = ticketRepo.findById(ticketId);
  if (!ticket) {
    return interaction.reply({ content: 'Ticket not found.', ephemeral: true });
  }
  if (ticket.status !== 'open') {
    return interaction.reply({
      content: 'This ticket is already closed.',
      ephemeral: true,
    });
  }

  // Authorization: ticket creator OR any staff role member can close.
  const ticketCreator = userRepo.findById(ticket.user_id);
  const isCreator = ticketCreator && ticketCreator.discord_id === interaction.user.id;
  const isStaff = _hasStaffRole(interaction.member);
  if (!isCreator && !isStaff) {
    return interaction.reply({
      content: 'Only the ticket creator or staff can close this ticket.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();
  return _closeTicket(interaction.client, ticket, interaction.user.id, 'closed', interaction);
}

/**
 * Auto-close handler — fired by timerService when the 7-day inactivity
 * timer expires. No interaction context; just runs the close path
 * silently and logs.
 */
async function handleAutoClose(client, ticketId) {
  const ticket = ticketRepo.findById(ticketId);
  if (!ticket) return;
  if (ticket.status !== 'open') return;
  return _closeTicket(client, ticket, 'system', 'auto_closed', null);
}

async function _closeTicket(client, ticket, closedByDiscordId, finalStatus, interaction) {
  // Atomic claim — repeated clicks on the Close button (or a click
  // racing the auto-close timer) only run the close path once.
  const claimed = ticketRepo.close(ticket.id, finalStatus, closedByDiscordId);
  if (!claimed) {
    if (interaction) {
      try { await interaction.editReply({ content: 'Ticket was already closed.' }); } catch { /* */ }
    }
    return;
  }

  // Cancel the auto-close timer (no-op for the auto-close path itself
  // since the timer already fired).
  timerService.cancelTimersByReference('ticket_inactivity', ticket.id);

  const channel = client.channels.cache.get(ticket.channel_id)
    || await client.channels.fetch(ticket.channel_id).catch(() => null);

  // Build + post transcript to the logs channel BEFORE deleting the
  // ticket channel. If anything fails here, we still want the channel
  // gone, so each step is wrapped in its own try/catch.
  if (channel) {
    try {
      await _postTranscript(client, channel, ticket, closedByDiscordId, finalStatus);
    } catch (err) {
      console.error(`[TicketClose] Transcript post failed for ticket #${ticket.id}: ${err.message}`);
    }
  }

  // Tell the channel it's closing.
  const reasonText = finalStatus === 'auto_closed'
    ? 'Auto-closed after 7 days with no activity'
    : `Closed by <@${closedByDiscordId}>`;
  if (channel) {
    try {
      await channel.send({
        content: `🔒 **Ticket closed.** ${reasonText}. This channel will be deleted in 60 seconds.`,
      });
    } catch { /* */ }
  }

  if (interaction) {
    try {
      await interaction.editReply({ content: `Ticket closed. Channel will be deleted in 60 seconds.` });
    } catch { /* */ }
  }

  // Delete the channel after 60s. setTimeout is fine here — we don't
  // care if a restart drops it, the channel just sits there as a
  // trivial leak (closed status in DB, no buttons, just a final message).
  setTimeout(async () => {
    if (!channel) return;
    try {
      await channel.delete(`Ticket #${ticket.id} ${finalStatus}`);
    } catch (err) {
      console.warn(`[TicketClose] Channel delete failed for ticket #${ticket.id}: ${err.message}`);
    }
  }, CHANNEL_DELETE_DELAY_MS);

  console.log(`[TicketClose] Ticket #${ticket.id} ${finalStatus} by ${closedByDiscordId}`);
}

async function _postTranscript(client, channel, ticket, closedByDiscordId, finalStatus) {
  const logsChannelId = process.env.TICKET_LOGS_CHANNEL_ID;
  if (!logsChannelId) return;
  const logsChannel = client.channels.cache.get(logsChannelId)
    || await client.channels.fetch(logsChannelId).catch(() => null);
  if (!logsChannel) {
    console.warn('[TicketClose] TICKET_LOGS_CHANNEL_ID set but unreachable');
    return;
  }

  // Paginate forward from the channel's start until we run out. Discord
  // returns max 100 per fetch and orders newest-first, so we collect
  // newest -> oldest, then reverse for the transcript.
  const collected = [];
  let before;
  for (let i = 0; i < 50; i++) { // 50 * 100 = 5000 messages cap, plenty for a ticket
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    for (const msg of batch.values()) collected.push(msg);
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  collected.reverse(); // oldest first

  const lines = collected.map(m => {
    const time = m.createdAt.toISOString().slice(0, 19).replace('T', ' ');
    const author = m.author.bot ? `[BOT] ${m.author.username}` : `${m.author.username} (${m.author.id})`;
    const content = m.content || '';
    const embedNotes = m.embeds.length > 0 ? ` [+ ${m.embeds.length} embed]` : '';
    const attachNotes = m.attachments.size > 0
      ? ` [+ ${[...m.attachments.values()].map(a => a.name).join(', ')}]`
      : '';
    return `[${time}] ${author}: ${content}${embedNotes}${attachNotes}`;
  });

  const ticketCreator = userRepo.findById(ticket.user_id);
  const creatorTag = ticketCreator?.server_username || ticketCreator?.discord_id || `user ${ticket.user_id}`;
  const categoryLabel = TICKET_CATEGORIES[ticket.category]?.label || ticket.category;

  const header = [
    `Ticket #${ticket.id} — ${categoryLabel}`,
    `Creator: ${creatorTag} (${ticketCreator?.discord_id || 'unknown'})`,
    `Channel: #${channel.name} (${channel.id})`,
    `Opened: ${ticket.opened_at}`,
    `Status: ${finalStatus}`,
    `Closed by: ${closedByDiscordId}`,
    `Messages: ${collected.length}`,
    '─'.repeat(60),
    '',
  ].join('\n');
  const transcript = header + lines.join('\n');

  const buf = Buffer.from(transcript, 'utf8');
  const file = new AttachmentBuilder(buf, { name: `ticket-${ticket.id}-transcript.txt` });

  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${ticket.id} — ${categoryLabel}`)
    .setColor(finalStatus === 'auto_closed' ? 0x95a5a6 : 0x2ecc71)
    .setDescription([
      `**Creator:** ${creatorTag} ${ticketCreator?.discord_id ? `(<@${ticketCreator.discord_id}>)` : ''}`,
      `**Status:** ${finalStatus === 'auto_closed' ? 'Auto-closed (7d inactive)' : 'Closed'}`,
      `**Closed by:** ${closedByDiscordId === 'system' ? 'System (auto)' : `<@${closedByDiscordId}>`}`,
      `**Messages:** ${collected.length}`,
      '',
      'Full transcript attached as a `.txt` file.',
    ].join('\n'))
    .setTimestamp();

  await logsChannel.send({ embeds: [embed], files: [file] });
}

function _hasStaffRole(member) {
  if (!member || !member.roles) return false;
  const staffRoleIds = [
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
  ].filter(Boolean);
  return staffRoleIds.some(id => member.roles.cache?.has(id));
}

module.exports = { handleCloseButton, handleAutoClose };
