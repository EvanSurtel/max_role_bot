// Ephemeral language switcher.
//
// A single "🌐 Language" button lives on every public bot panel (lobby,
// wallet, rules, howItWorks, xpMatch, leaderboards, welcome, etc). When any
// user clicks it from anywhere, they get an ephemeral dropdown in their
// current language listing every supported language. Picking a language
// saves it to the DB and shows an ephemeral confirmation in the new
// language. From that point on, every interaction response the user
// triggers will be rendered in their new language — including the wallet
// ephemeral, the wager creation flow, errors, and modals.
//
// No channel fan-out, no panel refresh, nothing breaks for other users.
// Because the switch is ephemeral, only the clicker sees the change.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { t, langFor } = require('../locales/i18n');
const { SUPPORTED_LANGUAGES } = require('../locales');
const userRepo = require('../database/repositories/userRepo');

/**
 * Handle the "🌐 Language" button click. Sends an ephemeral language
 * picker in the clicker's current language.
 */
async function handleShowLanguagePicker(interaction) {
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
      .setCustomId('lang_picker_select')
      .setPlaceholder(t('language_panel.placeholder', lang))
      .addOptions(options),
  );

  // _persist: true → this ephemeral doesn't auto-delete. The user may want
  // to keep the picker open while they decide, or come back to it later.
  await interaction.reply({
    embeds: [embed],
    components: [selectRow],
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Handle the language pick from the ephemeral dropdown. Saves the new
 * language to the user's DB row and updates the ephemeral message to
 * show a confirmation in the new language.
 *
 * If the user has NOT yet accepted TOS, we also send a follow-up
 * ephemeral with the welcome/TOS content rendered in their new language
 * — including the Accept/Decline buttons — so they can actually read
 * what they're agreeing to before they accept. This works regardless
 * of which channel they triggered the language switch from, but is
 * the main UX path for the welcome channel.
 */
async function handleLanguagePickerSelect(interaction) {
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

  // If the user hasn't accepted TOS yet, send the welcome/TOS panel as
  // an ephemeral follow-up in their new language so they can read what
  // they're about to accept. The Accept/Decline buttons are functional.
  const freshUser = userRepo.findByDiscordId(discordId);
  if (!freshUser || freshUser.accepted_tos !== 1) {
    try {
      const { buildWelcomePanel } = require('../panels/welcomePanel');
      const welcomeView = buildWelcomePanel(newLang);
      await interaction.followUp({
        ...welcomeView,
        ephemeral: true,
        _persist: true,
      });
    } catch (err) {
      console.error('[LanguageSwitcher] Failed to send welcome ephemeral:', err.message);
    }
  }
}

module.exports = {
  handleShowLanguagePicker,
  handleLanguagePickerSelect,
};
