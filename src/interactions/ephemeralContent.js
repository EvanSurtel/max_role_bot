// Per-user ephemeral content handlers.
//
// Discord messages are shared: a single message in a public channel looks
// the same to every viewer. That means the lobby / rules / howItWorks panels
// can't be "translated per viewer" the way a website could.
//
// Ephemeral messages ARE per-user though — only the person who triggered
// them sees them. So these handlers take button clicks from shared panels
// and respond with the same content as an EPHEMERAL message rendered in the
// clicker's personal language. Every user can view all of the bot's content
// in their own language, without affecting anyone else.
//
// Handlers:
//   show_rules         → ephemeral rules
//   show_howitworks    → ephemeral how-it-works
//   show_language      → ephemeral language picker
//   ephemeral_lang_select → apply language pick from the ephemeral picker
//
// For long content (rules has 11 embeds, how-it-works has 6) we pack into
// chunks that fit Discord's 10-embed / 5500-char per-message limit and
// send the first as the reply, the rest as ephemeral followUps.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { t, langFor } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');
const userRepo = require('../database/repositories/userRepo');

// Stay well under Discord's 6000-char/10-embed per-message limits so long
// translations (French, Filipino, Dutch) don't blow past them.
const CHUNK_CHAR_CAP = 5500;
const CHUNK_EMBED_CAP = 10;

function _embedChars(embed) {
  const data = embed.data || embed;
  let chars = (data.title || '').length + (data.description || '').length;
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      chars += (f.name || '').length + (f.value || '').length;
    }
  }
  if (data.footer && data.footer.text) chars += data.footer.text.length;
  return chars;
}

function _packEmbeds(embeds) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const e of embeds) {
    const ec = _embedChars(e);
    if (current.length > 0 && (current.length >= CHUNK_EMBED_CAP || chars + ec > CHUNK_CHAR_CAP)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += ec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Show the rules as an ephemeral message in the clicker's language.
 */
async function handleShowRules(interaction) {
  const lang = langFor(interaction);
  const { buildRulesEmbeds } = require('../panels/rulesPanel');
  const embeds = buildRulesEmbeds(lang);
  const groups = _packEmbeds(embeds);

  await interaction.reply({ embeds: groups[0], ephemeral: true });
  for (let i = 1; i < groups.length; i++) {
    await interaction.followUp({ embeds: groups[i], ephemeral: true });
  }
}

/**
 * Show how-it-works as an ephemeral message in the clicker's language.
 */
async function handleShowHowItWorks(interaction) {
  const lang = langFor(interaction);
  const { buildHowItWorksEmbeds } = require('../panels/howItWorksPanel');
  const embeds = buildHowItWorksEmbeds(lang);
  const groups = _packEmbeds(embeds);

  await interaction.reply({ embeds: groups[0], ephemeral: true });
  for (let i = 1; i < groups.length; i++) {
    await interaction.followUp({ embeds: groups[i], ephemeral: true });
  }
}

/**
 * Show an ephemeral language picker (only this user sees it). When they
 * pick a language, handleEphemeralLangSelect below applies the change.
 */
async function handleShowLanguage(interaction) {
  const lang = langFor(interaction);

  const embed = new EmbedBuilder()
    .setTitle(t('language_panel.title', lang))
    .setColor(0x3498db)
    .setDescription(t('language_panel.description', lang))
    .setFooter({ text: t('language_panel.footer', lang) });

  const options = Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === lang,
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('ephemeral_lang_select')
      .setPlaceholder(t('language_panel.placeholder', lang))
      .addOptions(options),
  );

  await interaction.reply({ embeds: [embed], components: [selectRow], ephemeral: true });
}

/**
 * Handle the dropdown pick from the ephemeral language picker. Saves the
 * user's new language, updates the ephemeral message to show a confirmation,
 * and kicks off a wallet-channel refresh in the background.
 */
async function handleEphemeralLangSelect(interaction) {
  const newLang = interaction.values[0];
  if (!SUPPORTED_LANGUAGES[newLang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user) {
    user = userRepo.create(discordId);
  }
  userRepo.setLanguage(discordId, newLang);

  const langName = SUPPORTED_LANGUAGES[newLang].nativeName;
  await interaction.update({
    content: t('onboarding.language_saved', newLang, { language: langName }),
    embeds: [],
    components: [],
  });

  // Refresh the user's wallet channel in their new language in the background.
  const { applyLanguageChange } = require('../utils/languageRefresh');
  applyLanguageChange(interaction.client, discordId, newLang).catch(err => {
    console.error('[EphemeralLang] Background wallet refresh failed:', err.message);
  });
}

module.exports = {
  handleShowRules,
  handleShowHowItWorks,
  handleShowLanguage,
  handleEphemeralLangSelect,
};
