const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const matchService = require('../services/matchService');
const { MATCH_STATUS } = require('../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub
        .setName('resolve')
        .setDescription('Resolve a disputed match')
        .addIntegerOption(opt =>
          opt.setName('match_id').setDescription('The match ID to resolve').setRequired(true),
        )
        .addIntegerOption(opt =>
          opt
            .setName('winning_team')
            .setDescription('The winning team number')
            .setRequired(true)
            .addChoices(
              { name: 'Team 1', value: 1 },
              { name: 'Team 2', value: 2 },
            ),
        ),
    ),

  async execute(interaction) {
    // Check permissions
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You do not have permission to use admin commands.',
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'resolve': {
        const matchId = interaction.options.getInteger('match_id');
        const winningTeam = interaction.options.getInteger('winning_team');

        // Find match
        const match = matchRepo.findById(matchId);
        if (!match) {
          return interaction.reply({
            content: `Match #${matchId} not found.`,
            ephemeral: true,
          });
        }

        // Verify match is in a resolvable state
        const resolvableStatuses = [MATCH_STATUS.VOTING, MATCH_STATUS.DISPUTED, MATCH_STATUS.ACTIVE];
        if (!resolvableStatuses.includes(match.status)) {
          return interaction.reply({
            content: `Match #${matchId} cannot be resolved in its current state (\`${match.status}\`).`,
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          await matchService.resolveMatch(interaction.client, matchId, winningTeam);

          return interaction.editReply({
            content: `**Match #${matchId} resolved!** Winner: **Team ${winningTeam}**\n\nEscrow disbursement and channel cleanup have been handled automatically.`,
          });
        } catch (err) {
          console.error('[Admin] Error resolving match:', err);
          return interaction.editReply({
            content: 'An error occurred while resolving the match. Please try again.',
          });
        }
      }
    }
  },
};
