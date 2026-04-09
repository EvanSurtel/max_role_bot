const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');

/**
 * Build the main lobby panel — wager creation only.
 * The panel renders in the requested language and includes language toggle buttons.
 */
function buildLobbyPanel(lang = 'en') {
  const embed = new EmbedBuilder()
    .setTitle(t('lobby.title', lang))
    .setColor(0xf1c40f)
    .setDescription(t('lobby.description', lang))
    .setFooter({ text: t('lobby.footer', lang) });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('wager_type_wager')
      .setLabel(t('lobby.btn_create_wager', lang))
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('create_dispute')
      .setLabel(t('lobby.btn_create_dispute', lang))
      .setStyle(ButtonStyle.Danger),
  );

  // Row 2: per-user ephemeral content buttons. These show rules, how it
  // works, and the language picker as EPHEMERAL messages only the clicker
  // sees — which lets every user read the bot content in their own language
  // even though the lobby message itself is shared.
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('show_rules')
      .setEmoji('📖')
      .setLabel(t('lobby.btn_rules', lang))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('show_howitworks')
      .setEmoji('❓')
      .setLabel(t('lobby.btn_howitworks', lang))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('show_language')
      .setEmoji('🌐')
      .setLabel(t('lobby.btn_language', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Post (or refresh) the lobby panel in the configured wager channel.
 */
async function postLobbyPanel(client, lang = 'en') {
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
    const panel = buildLobbyPanel(lang);

    if (existingPanel) {
      for (const [, m] of botMessages) { if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ } }
      await existingPanel.edit(panel);
      console.log(`[Panel] Updated existing lobby panel (${lang})`);
    } else {
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[Panel] Posted new lobby panel (${lang})`);
    }
  } catch (err) {
    console.error('[Panel] Failed to post lobby panel:', err.message);
  }
}

module.exports = { buildLobbyPanel, postLobbyPanel };
