const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const { USDC_PER_UNIT } = require('../config/constants');

/**
 * Handle the "Leaderboard" panel button click.
 * Shows leaderboard category selection buttons.
 */
async function handleLeaderboardButton(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lb_xp')
      .setLabel('XP')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('lb_earnings')
      .setLabel('Earnings')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('lb_wins')
      .setLabel('Wins')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({
    content: '**Select a leaderboard:**',
    components: [row],
    ephemeral: true,
  });
}

/**
 * Handle leaderboard sub-buttons (xp, earnings, wins).
 */
async function handleLeaderboardSubButton(interaction) {
  const id = interaction.customId;
  const callerId = interaction.user.id;

  if (id === 'lb_xp') {
    const rows = userRepo.getXpLeaderboard(10);

    if (rows.length === 0) {
      return interaction.reply({
        content: 'No XP data yet. Play some matches to get on the leaderboard!',
        ephemeral: true,
      });
    }

    const lines = rows.map((row, i) => {
      return `**#${i + 1}.** <@${row.discord_id}> — ${row.xp_points.toLocaleString()} XP`;
    });

    const callerInTop = rows.some(r => r.discord_id === callerId);
    if (!callerInTop) {
      const callerUser = userRepo.findByDiscordId(callerId);
      if (callerUser && callerUser.xp_points > 0) {
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

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (id === 'lb_earnings') {
    const rows = userRepo.getEarningsLeaderboard(10);

    if (rows.length === 0) {
      return interaction.reply({
        content: 'No earnings data yet. Win some wagers to get on the leaderboard!',
        ephemeral: true,
      });
    }

    const lines = rows.map((row, i) => {
      const usdc = (Number(row.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
      return `**#${i + 1}.** <@${row.discord_id}> — $${usdc} USDC earned`;
    });

    const callerInTop = rows.some(r => r.discord_id === callerId);
    if (!callerInTop) {
      const callerUser = userRepo.findByDiscordId(callerId);
      if (callerUser && Number(callerUser.total_earnings_usdc) > 0) {
        const allEarnings = userRepo.getEarningsLeaderboard(1000);
        const callerIndex = allEarnings.findIndex(r => r.discord_id === callerId);
        if (callerIndex !== -1) {
          const usdc = (Number(callerUser.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
          lines.push('');
          lines.push(`**#${callerIndex + 1}.** <@${callerId}> — $${usdc} USDC earned`);
        }
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Earnings Leaderboard')
      .setDescription(lines.join('\n'))
      .setColor(0x57F287)
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (id === 'lb_wins') {
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
      const record = `${row.total_wins}W - ${row.total_losses}L`;
      return `**#${i + 1}.** <@${row.discord_id}> — ${record}`;
    });

    const callerInTop = sorted.some(r => r.discord_id === callerId);
    if (!callerInTop) {
      const callerUser = userRepo.findByDiscordId(callerId);
      if (callerUser && callerUser.total_wins > 0) {
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

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

module.exports = { handleLeaderboardButton, handleLeaderboardSubButton };
