const { buildHowItWorksEmbeds } = require('../panels/howItWorksPanel');
const { buildRulesEmbeds } = require('../panels/rulesPanel');
const { buildLanguageRow, SUPPORTED_LANGUAGES } = require('../locales');

// customId format: lang_<panel>_<code>
// Supports: howItWorks, rules, welcome, lobby, xpPanel
async function handleButton(interaction) {
  const parts = interaction.customId.split('_');
  const panel = parts[1];
  const lang = parts[2];

  if (!SUPPORTED_LANGUAGES[lang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  try {
    if (panel === 'howItWorks') {
      const embeds = buildHowItWorksEmbeds(lang);
      return interaction.update({ embeds, components: [buildLanguageRow('howItWorks')] });
    }

    if (panel === 'welcome') {
      const { buildWelcomePanel } = require('../panels/welcomePanel');
      const view = buildWelcomePanel(lang);
      return interaction.update(view);
    }

    if (panel === 'lobby') {
      const { buildLobbyPanel } = require('../panels/lobbyPanel');
      const view = buildLobbyPanel(lang);
      return interaction.update(view);
    }

    if (panel === 'xpPanel') {
      const { buildXpMatchPanel } = require('../panels/xpMatchPanel');
      const view = buildXpMatchPanel(lang);
      return interaction.update(view);
    }

    if (panel === 'rules') {
      const embeds = buildRulesEmbeds(lang);
      const langRow = [buildLanguageRow('rules')];

      // Single-message case (≤10 embeds)
      if (embeds.length <= 10) {
        return interaction.update({ embeds, components: langRow });
      }

      // Multi-message case (11 embeds split across 2 messages, both have buttons)
      const part1Embeds = embeds.slice(0, 10);
      const part2Embeds = embeds.slice(10);

      // Identify which message the click came from by embed count
      const isPart1 = interaction.message.embeds.length === 10;

      if (isPart1) {
        // Update the clicked message (part 1) immediately to acknowledge interaction
        await interaction.update({ embeds: part1Embeds, components: langRow });
        // Then find and edit the sibling (part 2 = next bot message)
        const channel = interaction.channel;
        const after = await channel.messages.fetch({ limit: 5, after: interaction.message.id });
        const part2Msg = after.find(m => m.author.id === interaction.client.user.id);
        if (part2Msg) {
          await part2Msg.edit({ embeds: part2Embeds, components: langRow });
        }
      } else {
        // Click was on part 2
        await interaction.update({ embeds: part2Embeds, components: langRow });
        const channel = interaction.channel;
        const before = await channel.messages.fetch({ limit: 5, before: interaction.message.id });
        const part1Msg = before.find(m => m.author.id === interaction.client.user.id);
        if (part1Msg) {
          await part1Msg.edit({ embeds: part1Embeds, components: langRow });
        }
      }
      return;
    }

    return interaction.reply({ content: 'Unknown panel.', ephemeral: true });
  } catch (err) {
    console.error(`[Language] Failed to switch ${panel} to ${lang}:`, err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong. Try again.', ephemeral: true }).catch(() => {});
    }
  }
}

module.exports = { handleButton };
