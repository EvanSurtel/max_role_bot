// Discord embed builders — challenge board, match result, wallet, onboarding.
const { EmbedBuilder } = require('discord.js');
const { GAME_MODES, CHALLENGE_TYPE, USDC_PER_UNIT } = require('../config/constants');
const { t } = require('../locales/i18n');

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
 *
 * @param {object} challenge
 * @param {boolean} isAnonymous
 * @param {object[]|null} teamPlayers
 * @param {string} lang - language code (defaults to bot display language)
 */
function challengeEmbed(challenge, isAnonymous, teamPlayers, lang = 'en') {
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const typeLabel = isCashMatch
    ? t('challenge_create.type_cash_match', lang)
    : t('challenge_create.type_xp_match', lang);

  const embed = new EmbedBuilder()
    .setTitle(`${typeLabel} #${challenge.display_number || challenge.id}`)
    .setColor(isCashMatch ? 0xf1c40f : 0x3498db)
    .addFields(
      { name: t('challenge_create.confirm_field_team_size', lang), value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
      { name: t('challenge_create.confirm_field_mode', lang), value: modeLabel, inline: true },
      { name: t('challenge_create.confirm_field_series', lang), value: t('challenge_create.series_label', lang, { n: challenge.series_length }), inline: true },
    )
    .setTimestamp();

  if (isCashMatch) {
    const entry = formatUsdc(challenge.entry_amount_usdc);
    const matchPrize = formatUsdc(challenge.total_pot_usdc);
    embed.addFields(
      { name: t('challenge_create.confirm_field_entry', lang), value: `${entry} USDC ${t('challenge_create.per_player', lang)}`, inline: true },
      { name: t('challenge_create.confirm_field_match_prize', lang), value: `${matchPrize} USDC`, inline: true },
    );
  }

  if (!isAnonymous && teamPlayers && teamPlayers.length > 0) {
    // Render plain-text name first (always visible) then mention at
    // the end for click-through. Discord's <@id> resolver in embed
    // field values is inconsistent — sometimes renders as a pill,
    // sometimes as raw `<@123456>` text — so we never rely on it
    // alone. Primary source is server_username (Discord nickname at
    // registration); falls back to cod_ign if that's null.
    const playerList = teamPlayers.map(p => {
      const name = p.server_username || p.cod_ign || 'Player';
      const ignTag = p.cod_ign && p.cod_ign !== name ? ` (${p.cod_ign})` : '';
      return `**${name}**${ignTag} — <@${p.discord_id}>`;
    }).join('\n');
    embed.addFields({ name: t('challenge_create.challenger', lang), value: playerList });
  } else if (!isAnonymous) {
    embed.setFooter({ text: t('challenge_create.created_by_user', lang, { id: challenge.creator_user_id }) });
  } else {
    embed.setFooter({ text: t('challenge_create.visibility_anonymous', lang) });
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
      { name: 'Held in Matches', value: `${held} USDC`, inline: true },
      { name: 'Total', value: `${total} USDC`, inline: true },
      { name: 'Deposit Address', value: `\`${wallet.address}\`` },
    )
    .setTimestamp();
}

/**
 * Build the onboarding welcome embed with Terms & Conditions.
 */
function onboardingEmbed() {
  return new EmbedBuilder()
    .setTitle('Welcome to Rank $ - Call of Duty Mobile Cash Matches and XP Matches')
    .setColor(0xe74c3c)
    .setDescription(
      'Before you can participate in cash matches and XP matches, you must accept our Terms of Service.',
    )
    .addFields(
      {
        name: 'Terms of Service',
        value: [
          '1. You must be of legal age to participate in cash matches in your jurisdiction.',
          '2. All matches are final once started. No refunds for completed matches.',
          '3. You are responsible for the security of your account and wallet.',
          '4. Cheating, exploiting, or unsportsmanlike conduct will result in a ban and forfeiture of funds.',
          '5. The platform takes a fee from each match prize as stated in the challenge details.',
          '6. USDC deposits and withdrawals are your responsibility. The platform is not liable for incorrect addresses.',
          '7. Disputes will be resolved by server administrators. Their decision is final.',
          '8. The platform reserves the right to modify these terms at any time.',
        ].join('\n'),
      },
      {
        name: 'What happens next?',
        value:
          'When you accept, a Base wallet will be created for you. Deposit USDC to participate in cash matches.',
      },
    )
    .setFooter({ text: 'Click Accept to proceed or Decline to opt out.' });
}

/**
 * Build an embed showing match status.
 */
function matchEmbed(match, challenge) {
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
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

  if (isCashMatch) {
    embed.addFields({ name: 'Match Prize', value: `${formatUsdc(challenge.total_pot_usdc)} USDC`, inline: true });
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

/**
 * Build a localized result embed for a finished match. Used both for
 * the initial post to the results channels and for the per-message
 * "View in My Language" ephemeral.
 *
 * @param {object} match - match DB row
 * @param {object} challenge - challenge DB row
 * @param {object[]} winningPlayers - challenge_player rows for the winning team
 * @param {object[]} losingPlayers - challenge_player rows for the losing team
 * @param {object} userRepo - userRepo module (passed to avoid circular requires)
 * @param {number} winXp
 * @param {number} loseXp
 * @param {number} winningTeam - 1 or 2
 * @param {string} lang - language code
 */
function matchResultEmbed(match, challenge, winningPlayers, losingPlayers, userRepo, winXp, loseXp, winningTeam, lang = 'en') {
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const matchPrize = Number(challenge.total_pot_usdc);
  const entryAmount = Number(challenge.entry_amount_usdc);
  const perPlayerPayout = matchPrize > 0 && winningPlayers.length > 0 ? matchPrize / winningPlayers.length : 0;
  const perPlayerProfit = perPlayerPayout - entryAmount;
  const matchTypeLabel = isCashMatch
    ? t('challenge_create.type_cash_match', lang)
    : t('challenge_create.type_xp_match', lang);

  const winnerLines = [];
  for (const p of winningPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**+${formatUsdc(perPlayerProfit)} USDC** ` : '';
    winnerLines.push(`<@${u.discord_id}> ${ign} — ${moneyText}+${winXp} XP`);
  }
  const loserLines = [];
  for (const p of losingPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**-${formatUsdc(entryAmount)} USDC** ` : '';
    const xpText = loseXp > 0 ? `-${loseXp} XP` : '';
    loserLines.push(`<@${u.discord_id}> ${ign} — ${moneyText}${xpText}`);
  }

  const titleLine = isCashMatch
    ? t('match_result_embed.title_winner_match_prize', lang, { team: winningTeam, amount: (matchPrize / USDC_PER_UNIT).toFixed(2) })
    : t('match_result_embed.title_winner', lang, { team: winningTeam });

  const embed = new EmbedBuilder()
    .setTitle(t('match_result_embed.title', lang, { type: matchTypeLabel, matchId: match.id }))
    .setColor(isCashMatch ? 0xf1c40f : 0x3498db)
    .setDescription([
      titleLine,
      '',
      t('match_result_embed.winners_header', lang),
      ...winnerLines,
      '',
      t('match_result_embed.losers_header', lang),
      ...loserLines,
    ].join('\n'))
    .addFields(
      { name: t('match_result_embed.field_mode', lang), value: modeLabel, inline: true },
      { name: t('match_result_embed.field_series', lang), value: t('challenge_create.series_label', lang, { n: challenge.series_length }), inline: true },
      { name: t('match_result_embed.field_team_size', lang), value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
    )
    .setTimestamp();

  if (isCashMatch) {
    embed.addFields({
      name: t('match_result_embed.field_entry', lang),
      value: t('match_result_embed.entry_per_player_short', lang, { amount: (entryAmount / USDC_PER_UNIT).toFixed(2) }),
      inline: true,
    });
  }

  return embed;
}

module.exports = {
  formatUsdc,
  challengeEmbed,
  matchResultEmbed,
  walletEmbed,
  onboardingEmbed,
  matchEmbed,
  voteEmbed,
};
