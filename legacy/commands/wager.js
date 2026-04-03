const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wager')
    .setDescription('Start a new wager or XP match challenge'),

  async execute(interaction) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('wager_type_wager')
        .setLabel('Wager')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('💰'),
      new ButtonBuilder()
        .setCustomId('wager_type_xp')
        .setLabel('XP Match')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⚔️'),
    );

    await interaction.reply({
      content: '**Choose your match type:**\n\n💰 **Wager** — Put up XRP. Winner takes the pot.\n⚔️ **XP Match** — Play for bragging rights, no XRP on the line.',
      components: [row],
      ephemeral: true,
    });
  },
};
