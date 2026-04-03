const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const { XRP_DROPS_PER_XRP } = require('../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the server leaderboards')
    .addSubcommand(sub =>
      sub.setName('xp').setDescription('View the XP leaderboard'),
    )
    .addSubcommand(sub =>
      sub.setName('earnings').setDescription('View the earnings leaderboard'),
    )
    .addSubcommand(sub =>
      sub.setName('wins').setDescription('View the wins leaderboard'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'xp': {
        const rows = userRepo.getXpLeaderboard(10);

        if (rows.length === 0) {
          return interaction.reply({
            content: 'No XP data yet. Play some matches to get on the leaderboard!',
            ephemeral: true,
          });
        }

        const lines = rows.map((row, i) => {
          const rank = i + 1;
          return `**#${rank}.** <@${row.discord_id}> — ${row.xp_points.toLocaleString()} XP`;
        });

        // Check if the caller is in the top 10
        const callerId = interaction.user.id;
        const callerInTop = rows.some(r => r.discord_id === callerId);

        if (!callerInTop) {
          const callerUser = userRepo.findByDiscordId(callerId);
          if (callerUser && callerUser.xp_points > 0) {
            // Find caller's rank
            const allXp = userRepo.getXpLeaderboard(1000);
            const callerIndex = allXp.findIndex(r => r.discord_id === callerId);
            if (callerIndex !== -1) {
              lines.push('');
              lines.push(`**#${callerIndex + 1}.** <@${callerId}> — ${callerUser.xp_points.toLocaleString()} XP`);
            }
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('XP Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0x5865F2)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      case 'earnings': {
        const rows = userRepo.getEarningsLeaderboard(10);

        if (rows.length === 0) {
          return interaction.reply({
            content: 'No earnings data yet. Win some wagers to get on the leaderboard!',
            ephemeral: true,
          });
        }

        const lines = rows.map((row, i) => {
          const rank = i + 1;
          const xrp = (Number(row.total_earnings_drops) / XRP_DROPS_PER_XRP).toFixed(2);
          return `**#${rank}.** <@${row.discord_id}> — ${xrp} XRP earned`;
        });

        // Check if the caller is in the top 10
        const callerId = interaction.user.id;
        const callerInTop = rows.some(r => r.discord_id === callerId);

        if (!callerInTop) {
          const callerUser = userRepo.findByDiscordId(callerId);
          if (callerUser && Number(callerUser.total_earnings_drops) > 0) {
            const allEarnings = userRepo.getEarningsLeaderboard(1000);
            const callerIndex = allEarnings.findIndex(r => r.discord_id === callerId);
            if (callerIndex !== -1) {
              const xrp = (Number(callerUser.total_earnings_drops) / XRP_DROPS_PER_XRP).toFixed(2);
              lines.push('');
              lines.push(`**#${callerIndex + 1}.** <@${callerId}> — ${xrp} XRP earned`);
            }
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('Earnings Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0x57F287)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      case 'wins': {
        // For wins, we query XP leaderboard and sort by total_wins instead
        // Since there's no dedicated wins leaderboard query, we'll fetch broadly
        // and sort in JS. For a small community this is fine.
        const allUsers = userRepo.getXpLeaderboard(1000);
        const sorted = allUsers
          .filter(u => u.total_wins > 0)
          .sort((a, b) => b.total_wins - a.total_wins)
          .slice(0, 10);

        if (sorted.length === 0) {
          return interaction.reply({
            content: 'No wins recorded yet. Play some matches to get on the leaderboard!',
            ephemeral: true,
          });
        }

        const lines = sorted.map((row, i) => {
          const rank = i + 1;
          const record = `${row.total_wins}W - ${row.total_losses}L`;
          return `**#${rank}.** <@${row.discord_id}> — ${record}`;
        });

        // Check if the caller is in the top 10
        const callerId = interaction.user.id;
        const callerInTop = sorted.some(r => r.discord_id === callerId);

        if (!callerInTop) {
          const callerUser = userRepo.findByDiscordId(callerId);
          if (callerUser && callerUser.total_wins > 0) {
            // Compute rank among all users sorted by wins
            const fullSorted = allUsers
              .filter(u => u.total_wins > 0)
              .sort((a, b) => b.total_wins - a.total_wins);
            const callerIndex = fullSorted.findIndex(r => r.discord_id === callerId);
            if (callerIndex !== -1) {
              const record = `${callerUser.total_wins}W - ${callerUser.total_losses}L`;
              lines.push('');
              lines.push(`**#${callerIndex + 1}.** <@${callerId}> — ${record}`);
            }
          }
        }

        const embed = new EmbedBuilder()
          .setTitle('Wins Leaderboard')
          .setDescription(lines.join('\n'))
          .setColor(0xFEE75C)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }
    }
  },
};
