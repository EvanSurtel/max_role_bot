const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Build the main lobby panel — wager creation only.
 */
function buildLobbyPanel() {
  const embed = new EmbedBuilder()
    .setTitle('CODM Wager Bot')
    .setColor(0xf1c40f)
    .setDescription(
      [
        'Wager **USDC** on Call of Duty Mobile matches.',
        '',
        'Click **Create Wager** to challenge other players.',
      ].join('\n'),
    )
    .setFooter({ text: 'Powered by Solana' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_wager')
      .setLabel('Create Wager')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('create_dispute')
      .setLabel('Create Dispute')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Post (or refresh) the lobby panel in the configured wager channel.
 */
async function postLobbyPanel(client) {
  const channelId = process.env.WAGER_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WAGER_CHANNEL_ID not set — skipping lobby panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Wager channel ${channelId} not found in cache`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildLobbyPanel();

    if (existingPanel) {
      for (const [, m] of botMessages) { if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ } }
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing lobby panel');
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log('[Panel] Posted new lobby panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post lobby panel:', err.message);
  }
}

module.exports = { buildLobbyPanel, postLobbyPanel };
