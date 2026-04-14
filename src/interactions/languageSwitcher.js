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
 * language to the user's DB row, confirms the change in the new
 * language, and then sends a follow-up ephemeral with the panel from
 * THIS channel re-rendered in the new language. So if the user is in
 * the lobby and switches to Spanish, they get an ephemeral lobby in
 * Spanish with functional Create Wager / Create Dispute buttons. If
 * they're in the welcome channel, they get the TOS in Spanish with
 * functional Accept/Decline. Same for every channel.
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
    content: `<@${discordId}> ${t('onboarding.language_saved', newLang, { language: langName })}\n↓ **Scroll down** to see this channel in your language.`,
    embeds: [],
    components: [],
  });

  // Send an ephemeral copy of THIS channel's panel in the new language,
  // with functional buttons. This is what makes the language change
  // feel real — the user immediately sees the channel they're in
  // rendered in their new language.
  const { sendEphemeralPanelForCurrentChannel } = require('../utils/ephemeralPanelDispatcher');
  await sendEphemeralPanelForCurrentChannel(interaction, newLang);
}

/**
 * Handle the INLINE language dropdown directly on a shared panel.
 *
 * The dropdown lives on the public message itself (not behind a button)
 * so users can pick a language with one click. Discord select menu
 * state is per-viewer client-side, so picking doesn't change anything
 * visible to other users — they just see the dropdown unchanged.
 *
 * Behavior:
 *   1. Save the user's language to the DB
 *   2. Defer ephemeral reply (the auto-replace wrapper deletes any
 *      previous tracked ephemeral session for this user)
 *   3. Use the dispatcher to send the current channel's panel content
 *      in the new language as the ephemeral reply
 */
async function handleInlineLanguageSelect(interaction) {
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

  // Defer with ephemeral=true. This triggers the auto-replace wrapper
  // (deletes any previous ephemeral session for this user) and creates
  // a new tracked session. The dispatcher then editReply / followUp's
  // into it.
  await interaction.deferReply({ ephemeral: true, _persist: true });

  const { sendEphemeralPanelForCurrentChannel } = require('../utils/ephemeralPanelDispatcher');
  await sendEphemeralPanelForCurrentChannel(interaction, newLang);
}

module.exports = {
  handleShowLanguagePicker,
  handleLanguagePickerSelect,
  handleInlineLanguageSelect,
};
