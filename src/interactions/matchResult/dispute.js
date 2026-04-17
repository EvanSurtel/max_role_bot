// Dispute triggering + evidence posting to shared channel.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const { MATCH_STATUS, CHALLENGE_STATUS, CHALLENGE_TYPE, PLAYER_ROLE } = require('../../config/constants');
const { t, langFor } = require('../../locales/i18n');
const { buildLanguageDropdownRow } = require('../../utils/languageButtonHelper');

/**
 * Trigger dispute -- mark match as disputed and post admin resolve
 * buttons in the shared chat channel.
 *
 * @param {import('discord.js').Client} client
 * @param {number} matchId
 */
async function triggerDispute(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) return;

  if (match.status === MATCH_STATUS.DISPUTED) {
    console.log(`[MatchResult] Match #${matchId} already disputed, skipping`);
    return;
  }

  // Completed matches cannot be re-disputed (winnings already disbursed)
  if (match.status === MATCH_STATUS.COMPLETED) {
    console.warn(`[MatchResult] triggerDispute refused \u2014 match #${matchId} is already completed`);
    return;
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) return;

  matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

  // Post dispute in the existing shared-chat channel
  const sharedChannel = match.shared_text_id ? client.channels.cache.get(match.shared_text_id) : null;

  if (sharedChannel) {
    const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
    const allPings = allPlayers.map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}>` : '';
    }).filter(Boolean).join(' ');

    // Use first captain's language for shared dispute message
    const captainPlayer = allPlayers.find(p => p.role === PLAYER_ROLE.CAPTAIN);
    const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
    const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';

    const adsRoleId = process.env.ADS_ROLE_ID;
    const ceoRoleId = process.env.CEO_ROLE_ID;
    const ownerRoleId = process.env.OWNER_ROLE_ID;
    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
    const xpStaffId = process.env.XP_STAFF_ROLE_ID;

    // Staff ping scope depends on match type
    const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
    const pings = [];
    if (wagerStaffId) pings.push(`<@&${wagerStaffId}>`);
    if (xpStaffId && !isCashMatch) pings.push(`<@&${xpStaffId}>`);
    if (adminRoleId) pings.push(`<@&${adminRoleId}>`);
    if (ownerRoleId) pings.push(`<@&${ownerRoleId}>`);
    if (ceoRoleId) pings.push(`<@&${ceoRoleId}>`);
    if (adsRoleId) pings.push(`<@&${adsRoleId}>`);
    const staffPing = pings.length > 0 ? pings.join(' ') : 'Staff';

    const disputeLangRow = buildLanguageDropdownRow(sharedLang);
    await sharedChannel.send({
      content: [
        t('match_channel.match_disputed_title', sharedLang),
        '',
        allPings,
        '',
        t('match_channel.match_disputed_post_evidence', sharedLang),
        '',
        t('match_channel.staff_review', sharedLang, { staff: staffPing }),
      ].join('\n'),
      components: [...disputeLangRow],
    });

    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel(t('admin_resolve.btn_team1_wins', sharedLang)).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel(t('admin_resolve.btn_team2_wins', sharedLang)).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_no_winner', sharedLang)).setStyle(ButtonStyle.Secondary),
    );

    const adminLangRow = buildLanguageDropdownRow(sharedLang);
    await sharedChannel.send({ content: t('admin_resolve.staff_panel_title', sharedLang), components: [adminRow, ...adminLangRow] });
  }

  const { postTransaction: ptx } = require('../../utils/transactionFeed');
  ptx({ type: 'match_disputed', challengeId: match.challenge_id, memo: `Match #${matchId} disputed` });

  console.log(`[MatchResult] Match #${matchId} disputed`);
}

module.exports = { triggerDispute };
