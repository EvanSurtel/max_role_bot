const { EmbedBuilder } = require('discord.js');
const { GAME_MODES, CHALLENGE_TYPE, USDC_PER_UNIT } = require('../config/constants');

/**
 * Format a USDC smallest-unit amount as a human-readable dollar string.
 * @param {string|number} amount - Amount in USDC smallest units.
 * @returns {string} Formatted USDC amount (e.g. "$10.50" or "$0").
 */
function formatUsdc(amount) {
  const num = Number(amount);
  if (num === 0) return '$0';
  return `$${(num / USDC_PER_UNIT).toFixed(2)}`;
}

/**
 * Build an embed for the public challenge board.
 */
function challengeEmbed(challenge, isAnonymous, teamPlayers) {
  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

  const embed = new EmbedBuilder()
    .setTitle(`${isWager ? 'Wager' : 'XP Match'} Challenge #${challenge.id}`)
    .setColor(isWager ? 0xf1c40f : 0x3498db)
    .addFields(
      { name: 'Team Size', value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
      { name: 'Game Mode', value: modeLabel, inline: true },
      { name: 'Series', value: `Best of ${challenge.series_length}`, inline: true },
    )
    .setTimestamp();

  if (isWager) {
    const entry = formatUsdc(challenge.entry_amount_usdc);
    const pot = formatUsdc(challenge.total_pot_usdc);
    embed.addFields(
      { name: 'Entry', value: `${entry} USDC per player`, inline: true },
      { name: 'Total Pot', value: `${pot} USDC`, inline: true },
    );
  }

  if (!isAnonymous && teamPlayers && teamPlayers.length > 0) {
    const playerList = teamPlayers.map(p => `<@${p.discord_id}>${p.cod_ign ? ` (${p.cod_ign})` : ''}`).join('\n');
    embed.addFields({ name: 'Challenger', value: playerList });
  } else if (!isAnonymous) {
    embed.setFooter({ text: `Created by user #${challenge.creator_user_id}` });
  } else {
    embed.setFooter({ text: 'Anonymous challenge' });
  }

  return embed;
}

/**
 * Build an embed displaying wallet balance information.
 */
function walletEmbed(wallet, user) {
  const available = formatUsdc(wallet.balance_available);
  const held = formatUsdc(wallet.balance_held);
  const total = formatUsdc(
    Number(wallet.balance_available) + Number(wallet.balance_held),
  );

  return new EmbedBuilder()
    .setTitle('Wallet Balance')
    .setColor(0x2ecc71)
    .setDescription(`Balance for **${user.username}**`)
    .addFields(
      { name: 'Available', value: `${available} USDC`, inline: true },
      { name: 'Held in Wagers', value: `${held} USDC`, inline: true },
      { name: 'Total', value: `${total} USDC`, inline: true },
      { name: 'Deposit Address', value: `\`${wallet.solana_address}\`` },
    )
    .setTimestamp();
}

/**
 * Build the onboarding welcome embed with Terms & Conditions.
 */
function onboardingEmbed() {
  return new EmbedBuilder()
    .setTitle('Welcome to CODM Wagers')
    .setColor(0xe74c3c)
    .setDescription(
      'Before you can participate in wagers and XP matches, you must accept our Terms of Service.',
    )
    .addFields(
      {
        name: 'Terms of Service',
        value: [
          '1. You must be of legal age to participate in wagers in your jurisdiction.',
          '2. All wagers are final once a match begins. No refunds for completed matches.',
          '3. You are responsible for the security of your account and wallet.',
          '4. Cheating, exploiting, or unsportsmanlike conduct will result in a ban and forfeiture of funds.',
          '5. The platform takes a fee from each wager pot as stated in the challenge details.',
          '6. USDC deposits and withdrawals are your responsibility. The platform is not liable for incorrect addresses.',
          '7. Disputes will be resolved by server administrators. Their decision is final.',
          '8. The platform reserves the right to modify these terms at any time.',
        ].join('\n'),
      },
      {
        name: 'What happens next?',
        value:
          'When you accept, a Solana wallet will be created for you. Deposit USDC to participate in wager matches. You will also need a tiny amount of SOL (~$0.50) for transaction fees.',
      },
    )
    .setFooter({ text: 'Click Accept to proceed or Decline to opt out.' });
}

/**
 * Build an embed showing match status.
 */
function matchEmbed(match, challenge) {
  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

  const embed = new EmbedBuilder()
    .setTitle(`Match #${match.id}`)
    .setColor(0x9b59b6)
    .addFields(
      { name: 'Status', value: match.status, inline: true },
      { name: 'Team Size', value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
      { name: 'Game Mode', value: modeLabel, inline: true },
      { name: 'Series', value: `Best of ${challenge.series_length}`, inline: true },
    )
    .setTimestamp();

  if (isWager) {
    embed.addFields({ name: 'Pot', value: `${formatUsdc(challenge.total_pot_usdc)} USDC`, inline: true });
  }

  if (match.winning_team) {
    embed.addFields({ name: 'Winner', value: `Team ${match.winning_team}`, inline: true });
  }

  return embed;
}

/**
 * Build an embed for captain voting.
 */
function voteEmbed(matchId) {
  return new EmbedBuilder()
    .setTitle(`Match #${matchId} — Vote on Results`)
    .setColor(0xe67e22)
    .setDescription(
      'Both team captains must vote on who won the match.\n\n' +
      'If both captains agree, the match is resolved automatically.\n' +
      'If votes disagree, the match enters dispute resolution.',
    )
    .addFields({
      name: 'How to vote',
      value: 'Click the button for the team you believe won.',
    })
    .setFooter({ text: 'You have 2 hours from the first vote to submit yours.' });
}

module.exports = {
  formatUsdc,
  challengeEmbed,
  walletEmbed,
  onboardingEmbed,
  matchEmbed,
  voteEmbed,
};
