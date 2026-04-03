const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { onboardingEmbed } = require('../utils/embeds');

/**
 * Build the welcome/TOS panel — posted in the welcome channel on startup.
 */
function buildWelcomePanel() {
  const embed = onboardingEmbed();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tos_accept')
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tos_decline')
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Post (or refresh) the welcome panel in the configured welcome channel.
 */
async function postWelcomePanel(client) {
  const channelId = process.env.WELCOME_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WELCOME_CHANNEL_ID not set — skipping welcome panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Welcome channel ${channelId} not found in cache`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existingPanel = messages.find(
      m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0]?.title === 'Welcome to CODM Wagers',
    );

    const panel = buildWelcomePanel();

    if (existingPanel) {
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing welcome panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted new welcome panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post welcome panel:', err.message);
  }
}

module.exports = { buildWelcomePanel, postWelcomePanel };
