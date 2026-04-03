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
        'Wager **USDC** on Call of Duty matches against other players.',
        '',
        'Click the button below to create a wager.',
      ].join('\n'),
    )
    .setFooter({ text: 'Powered by Solana' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_wager')
      .setLabel('Create Wager')
      .setStyle(ButtonStyle.Success),
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
    const messages = await channel.messages.fetch({ limit: 10 });
    const existingPanel = messages.find(
      m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0]?.title === 'CODM Wager Bot',
    );

    const panel = buildLobbyPanel();

    if (existingPanel) {
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing lobby panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted new lobby panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post lobby panel:', err.message);
  }
}

module.exports = { buildLobbyPanel, postLobbyPanel };
