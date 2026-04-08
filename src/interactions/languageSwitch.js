const { buildHowItWorksEmbeds } = require('../panels/howItWorksPanel');
const { buildRulesEmbeds } = require('../panels/rulesPanel');
const { buildLanguageRow, SUPPORTED_LANGUAGES } = require('../locales');

// lang_howItWorks_es, lang_rules_pt, etc.
async function handleButton(interaction) {
  const parts = interaction.customId.split('_');
  // customId format: lang_<panel>_<code>
  const panel = parts[1];
  const lang = parts[2];

  if (!SUPPORTED_LANGUAGES[lang]) {
    return interaction.reply({ content: 'Unknown language.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    let embeds;
    if (panel === 'howItWorks') {
      embeds = buildHowItWorksEmbeds(lang);
    } else if (panel === 'rules') {
      embeds = buildRulesEmbeds(lang);
    } else {
      return interaction.editReply({ content: 'Unknown panel.' });
    }

    // Discord max 10 embeds per message — split if needed
    if (embeds.length <= 10) {
      await interaction.editReply({ embeds, components: [buildLanguageRow(panel)] });
    } else {
      await interaction.editReply({ embeds: embeds.slice(0, 10) });
      await interaction.followUp({ embeds: embeds.slice(10), components: [buildLanguageRow(panel)], ephemeral: true });
    }
  } catch (err) {
    console.error(`[Language] Failed to send ${panel} in ${lang}:`, err.message);
    await interaction.editReply({ content: 'Something went wrong. Try again.' }).catch(() => {});
  }
}

module.exports = { handleButton };
