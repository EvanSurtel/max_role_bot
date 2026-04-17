// Server rules panel — game settings, banned weapons, no-show rules, cash/XP match rules.
const { EmbedBuilder } = require('discord.js');
const { getLocale } = require('../locales');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

function buildRulesEmbeds(lang = 'en') {
  const t = getLocale('rules', lang);

  const generalEmbed = new EmbedBuilder()
    .setTitle(t.general.title)
    .setColor(0xe74c3c)
    .setDescription(t.general.description);

  const gameSettingsEmbed = new EmbedBuilder()
    .setTitle(t.gameSettings.title)
    .setColor(0x3498db)
    .addFields(t.gameSettings.fields);

  const bannedWeaponsEmbed = new EmbedBuilder()
    .setTitle(t.bannedWeapons.title)
    .setColor(0xe74c3c)
    .setDescription(t.bannedWeapons.description)
    .addFields(t.bannedWeapons.fields);

  const bannedAttachmentsEmbed = new EmbedBuilder()
    .setTitle(t.bannedAttachments.title)
    .setColor(0xe74c3c)
    .addFields(t.bannedAttachments.fields);

  const bannedUtilityEmbed = new EmbedBuilder()
    .setTitle(t.bannedUtility.title)
    .setColor(0xe74c3c)
    .addFields(t.bannedUtility.fields);

  const allowedEmbed = new EmbedBuilder()
    .setTitle(t.allowed.title)
    .setColor(0x2ecc71)
    .addFields(t.allowed.fields);

  const cosmeticsEmbed = new EmbedBuilder()
    .setTitle(t.cosmetics.title)
    .setColor(0x95a5a6)
    .addFields(t.cosmetics.fields);

  const weaponRolesEmbed = new EmbedBuilder()
    .setTitle(t.weaponRoles.title)
    .setColor(0x3498db)
    .setDescription(t.weaponRoles.description);

  const noShowEmbed = new EmbedBuilder()
    .setTitle(t.noShow.title)
    .setColor(0xf39c12)
    .setDescription(t.noShow.description);

  const cashMatchRulesEmbed = new EmbedBuilder()
    .setTitle(t.cashMatchRules.title)
    .setColor(0xf1c40f)
    .setDescription(t.cashMatchRules.description);

  const xpMatchRulesEmbed = new EmbedBuilder()
    .setTitle(t.xpRules.title)
    .setColor(0x3498db)
    .setDescription(t.xpRules.description);
  if (t.xpRules.footer) {
    xpMatchRulesEmbed.setFooter({ text: t.xpRules.footer });
  }

  return [generalEmbed, gameSettingsEmbed, bannedWeaponsEmbed, bannedAttachmentsEmbed, bannedUtilityEmbed, allowedEmbed, cosmeticsEmbed, weaponRolesEmbed, noShowEmbed, cashMatchRulesEmbed, xpMatchRulesEmbed];
}

function buildRulesPanel(lang = 'en') {
  // No language toggle here — the welcome panel and dedicated language
  // channel are the only places to switch languages.
  return {
    embeds: buildRulesEmbeds(lang),
    components: [],
  };
}

async function postRulesPanel(client, lang = 'en') {
  const channelId = process.env.RULES_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] RULES_CHANNEL_ID not set — skipping rules panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }

    const panel = buildRulesPanel(lang);

    // Post the language dropdown as its OWN small message at the very
    // top of the channel. Components on an embed message render BELOW
    // the embeds, which puts the dropdown below the rules content if
    // we attach it to the first embed message — defeating the purpose
    // of "at the top". A standalone dropdown message fixes that.
    await channel.send({
      content: '🌐 Pick a language to view the rules in:',
      components: [...buildLanguageDropdownRow(lang)],
    });

    // Discord max 10 embeds per message — split if needed
    if (panel.embeds.length <= 10) {
      await channel.send({ embeds: panel.embeds });
    } else {
      await channel.send({ embeds: panel.embeds.slice(0, 10) });
      await channel.send({ embeds: panel.embeds.slice(10) });
    }
    console.log(`[Panel] Posted rules panel (${lang})`);
  } catch (err) {
    console.error('[Panel] Failed to post rules panel:', err.message);
  }
}

module.exports = { buildRulesEmbeds, buildRulesPanel, postRulesPanel };
