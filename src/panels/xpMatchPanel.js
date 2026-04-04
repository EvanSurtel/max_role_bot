const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Build the XP match panel.
 */
function buildXpMatchPanel() {
  const embed = new EmbedBuilder()
    .setTitle('XP Matches')
    .setColor(0x3498db)
    .setDescription(
      [
        'Compete for **XP** against other players. No money involved.',
        '',
        'XP is calculated using an ELO system — beat stronger teams for more XP.',
      ].join('\n'),
    )
    .setFooter({ text: 'XP synced with NeatQueue' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_xp')
      .setLabel('Create XP Match')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Post (or refresh) the XP match panel.
 */
async function postXpMatchPanel(client) {
  const channelId = process.env.XP_MATCH_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] XP_MATCH_CHANNEL_ID not set — skipping XP match panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] XP match channel ${channelId} not found`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existingPanel = messages.find(
      m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0]?.title === 'XP Matches',
    );

    const panel = buildXpMatchPanel();

    if (existingPanel) {
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing XP match panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted new XP match panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post XP match panel:', err.message);
  }
}

module.exports = { buildXpMatchPanel, postXpMatchPanel };
