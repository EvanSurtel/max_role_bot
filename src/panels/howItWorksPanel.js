const { EmbedBuilder } = require('discord.js');
const { getLocale, buildLanguageRow } = require('../locales');

function buildHowItWorksEmbeds(lang = 'en') {
  const t = getLocale('howItWorks', lang);

  const introEmbed = new EmbedBuilder()
    .setTitle(t.intro.title)
    .setColor(0x3498db)
    .setDescription(t.intro.description);

  const walletExplainEmbed = new EmbedBuilder()
    .setTitle(t.wallet.title)
    .setColor(0x2ecc71)
    .setDescription(t.wallet.description);

  const cryptoEmbed = new EmbedBuilder()
    .setTitle(t.funding.title)
    .setColor(0xf1c40f)
    .setDescription(t.funding.description);

  const wagerEmbed = new EmbedBuilder()
    .setTitle(t.wager.title)
    .setColor(0xf1c40f)
    .setDescription(t.wager.description);

  const xpEmbed = new EmbedBuilder()
    .setTitle(t.xp.title)
    .setColor(0x3498db)
    .setDescription(t.xp.description);

  const tipsEmbed = new EmbedBuilder()
    .setTitle(t.tips.title)
    .setColor(0x95a5a6)
    .setDescription(t.tips.description);

  return [introEmbed, walletExplainEmbed, cryptoEmbed, wagerEmbed, xpEmbed, tipsEmbed];
}

function buildHowItWorksPanel(lang = 'en') {
  return {
    embeds: buildHowItWorksEmbeds(lang),
    components: [buildLanguageRow('howItWorks')],
  };
}

async function postHowItWorksPanel(client) {
  const channelId = process.env.HOW_IT_WORKS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] HOW_IT_WORKS_CHANNEL_ID not set — skipping');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const panel = buildHowItWorksPanel();
    await channel.send(panel);
    console.log('[Panel] Posted how it works panel');
  } catch (err) {
    console.error('[Panel] Failed to post how it works panel:', err.message);
  }
}

module.exports = { buildHowItWorksEmbeds, buildHowItWorksPanel, postHowItWorksPanel };
