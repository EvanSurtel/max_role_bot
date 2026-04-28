// How It Works guide panel — 5 step walkthrough posted to HOW_IT_WORKS_CHANNEL_ID.
const { EmbedBuilder } = require('discord.js');
const { getLocale } = require('../locales');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

// How It Works has 6 embeds totaling ~8000 characters in English and up to
// ~9500 in some languages (French, German, Dutch, Filipino). Discord caps a
// single message at 6000 chars across all embeds. We pack embeds greedily
// into as many messages as needed so each message stays under the cap.
const DISCORD_MESSAGE_CHAR_CAP = 5500; // 500-char headroom under Discord's 6000 limit

function _embedChars(embed) {
  return (embed.data.title || '').length + (embed.data.description || '').length;
}

/**
 * Greedily pack embeds into the minimum number of messages such that each
 * message stays under DISCORD_MESSAGE_CHAR_CAP. Returns an array of arrays,
 * one per message.
 */
function _packEmbeds(embeds) {
  const groups = [];
  let current = [];
  let currentChars = 0;
  for (const e of embeds) {
    const ec = _embedChars(e);
    if (current.length > 0 && currentChars + ec > DISCORD_MESSAGE_CHAR_CAP) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(e);
    currentChars += ec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildHowItWorksEmbeds(lang = 'en') {
  const t = getLocale('howItWorks', lang);

  const embeds = [];

  if (t.intro) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.intro.title)
      .setColor(0x3498db)
      .setDescription(t.intro.description));
  }

  // Step 1: Set Up Your Wallet (passkey + daily limit). Renders before
  // the deposit step so first-time readers see "create the wallet"
  // before "fund the wallet". Older locales without the `setup` key
  // skip this block harmlessly.
  if (t.setup) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.setup.title)
      .setColor(0x9b59b6)
      .setDescription(t.setup.description));
  }

  if (t.wallet) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.wallet.title)
      .setColor(0x2ecc71)
      .setDescription(t.wallet.description));
  }

  // Legacy section — old locales may still have 'funding', new ones don't
  if (t.funding) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.funding.title)
      .setColor(0xf1c40f)
      .setDescription(t.funding.description));
  }

  // cashMatch is the current key; wager is the legacy key for untranslated locales
  const cashMatchSection = t.cashMatch || t.wager;
  if (cashMatchSection) {
    embeds.push(new EmbedBuilder()
      .setTitle(cashMatchSection.title)
      .setColor(0xf1c40f)
      .setDescription(cashMatchSection.description));
  }

  if (t.xp) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.xp.title)
      .setColor(0x3498db)
      .setDescription(t.xp.description));
  }

  if (t.withdraw) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.withdraw.title)
      .setColor(0xe67e22)
      .setDescription(t.withdraw.description));
  }

  if (t.tips) {
    embeds.push(new EmbedBuilder()
      .setTitle(t.tips.title)
      .setColor(0x95a5a6)
      .setDescription(t.tips.description));
  }

  return embeds;
}

function buildHowItWorksPanel(lang = 'en') {
  // No language toggle here — the welcome panel and dedicated language
  // channel are the only places to switch languages.
  return {
    embeds: buildHowItWorksEmbeds(lang),
    components: [],
  };
}

async function postHowItWorksPanel(client, lang = 'en') {
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

    // Skip-if-intact: this panel is multiple messages (lang dropdown
    // + N packed embed groups). Editing in place is awkward; if any
    // bot embed message exists, assume the panel is good.
    const hasEmbeds = botMessages.some(m => m.embeds.length > 0);
    if (hasEmbeds) {
      console.log('[Panel] How it works panel already present — skipping re-post');
      return;
    }

    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const panel = buildHowItWorksPanel(lang);

    // Post the language dropdown as its OWN small message at the very
    // top of the channel. Components on an embed message render BELOW
    // the embeds, which would push the dropdown to the bottom of the
    // first chunk — defeating the purpose of "at the top".
    await channel.send({
      content: '🌐 Pick a language to view this guide in:',
      components: [...buildLanguageDropdownRow(lang)],
    });

    // Greedily pack embeds into messages so each stays under Discord's
    // 6000-char per-message limit.
    const groups = _packEmbeds(panel.embeds);
    for (const group of groups) {
      await channel.send({ embeds: group });
    }
    console.log(`[Panel] Posted how it works panel (${lang}, ${groups.length} messages)`);
  } catch (err) {
    console.error('[Panel] Failed to post how it works panel:', err.message);
  }
}

module.exports = { buildHowItWorksEmbeds, buildHowItWorksPanel, postHowItWorksPanel, _packEmbeds };
