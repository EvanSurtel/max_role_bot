// Post dispute result with evidence to the permanent dispute results channel.
const { EmbedBuilder } = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');

/**
 * Post full dispute result with all evidence to the permanent dispute
 * results channel. Called after admin resolves a disputed match.
 *
 * @param {import('discord.js').Client} client
 * @param {number} matchId
 * @param {number} winningTeam - 0 for no winner.
 * @param {string} resolverDiscordId
 */
async function postDisputeResult(client, matchId, winningTeam, resolverDiscordId) {
  const channelId = process.env.DISPUTE_RESULTS_CHANNEL_ID;
  if (!channelId) return;

  let ch = client.channels.cache.get(channelId);
  if (!ch) {
    try { ch = await client.channels.fetch(channelId); } catch { ch = null; }
  }
  if (!ch) {
    console.error(`[MatchResult] DISPUTE_RESULTS_CHANNEL_ID=${channelId} unreachable for match #${matchId}`);
    return;
  }

  try {
    const match = matchRepo.findById(matchId);
    const challenge = match ? challengeRepo.findById(match.challenge_id) : null;
    const allPlayers = match ? challengePlayerRepo.findByChallengeId(match.challenge_id) : [];

    const evidenceRepo = require('../../database/repositories/evidenceRepo');
    const allEvidence = evidenceRepo.findByMatchId(matchId);

    const team1 = allPlayers.filter(p => p.team === 1).map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}> ${u.cod_ign || ''}` : 'Unknown';
    });
    const team2 = allPlayers.filter(p => p.team === 2).map(p => {
      const u = userRepo.findById(p.user_id);
      return u ? `<@${u.discord_id}> ${u.cod_ign || ''}` : 'Unknown';
    });

    const { GAME_MODES } = require('../../config/constants');
    const { formatUsdc } = require('../../utils/embeds');
    const modeInfo = challenge ? GAME_MODES[challenge.game_modes] : null;
    const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');

    const outcomeText = winningTeam === 0
      ? '**No Winner** \u2014 All funds refunded'
      : `**Team ${winningTeam} wins**`;

    const prizeText = challenge && Number(challenge.total_pot_usdc) > 0
      ? `**Match Prize:** ${formatUsdc(challenge.total_pot_usdc)} USDC`
      : 'XP Match';

    const resultEmbed = new EmbedBuilder()
      .setTitle(`Dispute Result \u2014 Match #${matchId}`)
      .setColor(winningTeam === 0 ? 0x95a5a6 : 0x2ecc71)
      .setDescription([
        `**Resolved by:** <@${resolverDiscordId}>`,
        `**Outcome:** ${outcomeText}`,
        '',
        `**Match Details**`,
        `Mode: ${modeLabel} | Bo${challenge?.series_length || '?'} | ${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`,
        prizeText,
        '',
        `**Team 1:**`,
        ...team1,
        '',
        `**Team 2:**`,
        ...team2,
      ].join('\n'))
      .setTimestamp();

    await ch.send({ embeds: [resultEmbed] });

    // Archive evidence messages from the shared-chat channel
    let disputeMessages = [];
    try {
      if (match.shared_text_id) {
        const sharedCh = client.channels.cache.get(match.shared_text_id);
        if (sharedCh) {
          const msgs = await sharedCh.messages.fetch({ limit: 100 });
          disputeMessages = [...msgs.values()].reverse();
        }
      }
    } catch (err) {
      console.error(`[MatchResult] Failed to fetch dispute messages:`, err.message);
    }

    if (disputeMessages.length > 0) {
      await ch.send({ content: `**Evidence & Discussion (${disputeMessages.filter(m => !m.author.bot).length} messages):**` });

      for (const msg of disputeMessages) {
        if (msg.author.bot) continue;

        const parts = [];
        parts.push(`**<@${msg.author.id}>** \u2014 ${msg.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`);
        if (msg.content) parts.push(msg.content);

        const files = [];
        for (const [, att] of msg.attachments) {
          files.push(att.url);
        }

        const sendOpts = { content: parts.join('\n') };
        if (files.length > 0) {
          sendOpts.content += '\n' + files.join('\n');
        }

        try {
          await ch.send(sendOpts);
        } catch { /* skip if message too long */ }
      }
    } else {
      await ch.send({ content: `*No evidence was posted for Match #${matchId}.*` });
    }

    await ch.send({ content: '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500' });

  } catch (err) {
    console.error(`[MatchResult] Failed to post dispute result for match #${matchId}:`, err.message);
  }
}

module.exports = { postDisputeResult };
