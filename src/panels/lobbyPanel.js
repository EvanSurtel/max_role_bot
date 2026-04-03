const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Build the main lobby panel embed and buttons.
 * This is posted in the wager channel on bot startup.
 * Users click buttons to create matches, manage wallets, and view leaderboards.
 *
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[] }}
 */
function buildLobbyPanel() {
  const embed = new EmbedBuilder()
    .setTitle('CODM Wager Bot')
    .setColor(0xf1c40f)
    .setDescription(
      [
        'Create matches and wager **USDC** against other players.',
        '',
        'Click a button below to get started.',
      ].join('\n'),
    )
    .addFields(
      {
        name: 'Create Wager',
        value: 'Wager USDC on a match against an opponent.',
        inline: true,
      },
      {
        name: 'Create XP Match',
        value: 'Play for XP rankings — no money involved.',
        inline: true,
      },
    )
    .setFooter({ text: 'Powered by Solana' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_wager')
      .setLabel('Create Wager')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('wager_type_xp')
      .setLabel('Create XP Match')
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_wallet')
      .setLabel('My Wallet')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('panel_leaderboard')
      .setLabel('Leaderboard')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Post (or refresh) the lobby panel in the configured wager channel.
 * @param {import('discord.js').Client} client
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

  // Check if we already have a panel message (look for our bot's messages)
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
