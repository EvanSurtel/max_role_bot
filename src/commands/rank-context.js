// "View Rank" user context menu command.
//
// Right-click (or long-press on mobile) any user in chat → Apps →
// "View Rank" and the bot replies with the same trading-card embed
// the /rank slash command produces. Lets you check someone's rank
// without typing anything.

const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');
const { buildRankCard } = require('./rank');
const { langFor } = require('../locales/i18n');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('View Rank')
    .setType(ApplicationCommandType.User),

  async execute(interaction) {
    const target = interaction.targetUser;
    const lang = langFor(interaction);

    await interaction.deferReply();
    const result = await buildRankCard(target, lang);

    if (result.kind === 'error') {
      return interaction.editReply({ content: result.content });
    }
    return interaction.editReply({ embeds: result.embeds, files: result.files });
  },
};
