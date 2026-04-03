const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const matchService = require('../services/matchService');
const { MATCH_STATUS, CHALLENGE_STATUS, TIMERS } = require('../config/constants');

// Track vote deadline timers so they can be cleared if both captains vote in time
const voteTimers = new Map(); // matchId -> timeout handle

/**
 * Handle button interactions for captain match result voting.
 * customId format: vote_team1_${matchId} or vote_team2_${matchId}
 */
async function handleButton(interaction) {
  const customId = interaction.customId;

  // Parse customId: vote_team1_123 or vote_team2_123
  let votedTeam;
  let matchId;

  if (customId.startsWith('vote_team1_')) {
    votedTeam = 1;
    matchId = parseInt(customId.replace('vote_team1_', ''), 10);
  } else if (customId.startsWith('vote_team2_')) {
    votedTeam = 2;
    matchId = parseInt(customId.replace('vote_team2_', ''), 10);
  } else {
    return interaction.reply({ content: 'Invalid vote action.', ephemeral: true });
  }

  if (isNaN(matchId)) {
    return interaction.reply({ content: 'Invalid match.', ephemeral: true });
  }

  // Get the match from DB
  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.reply({ content: 'Match not found.', ephemeral: true });
  }

  // Validate match status is 'active' or 'voting'
  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({
      content: 'This match is no longer accepting votes.',
      ephemeral: true,
    });
  }

  // Get the challenge and all players
  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    return interaction.reply({ content: 'Associated challenge not found.', ephemeral: true });
  }

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);

  // Find the user in DB
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({
      content: 'You are not registered. Please complete onboarding first.',
      ephemeral: true,
    });
  }

  // Determine if this user is captain 1 or captain 2
  let captainNumber = null;
  for (const player of allPlayers) {
    if (player.user_id === user.id && player.role === 'captain') {
      captainNumber = player.team;
      break;
    }
  }

  if (captainNumber === null) {
    return interaction.reply({
      content: 'Only team captains can vote on match results.',
      ephemeral: true,
    });
  }

  // Check if this captain already voted
  if (captainNumber === 1 && match.captain1_vote !== null) {
    return interaction.reply({
      content: `You already voted for **Team ${match.captain1_vote}**. You cannot change your vote.`,
      ephemeral: true,
    });
  }
  if (captainNumber === 2 && match.captain2_vote !== null) {
    return interaction.reply({
      content: `You already voted for **Team ${match.captain2_vote}**. You cannot change your vote.`,
      ephemeral: true,
    });
  }

  // Record the vote
  matchRepo.setCaptainVote(matchId, captainNumber, votedTeam);

  // Update match status to 'voting' if this is the first vote
  if (match.status === MATCH_STATUS.ACTIVE) {
    matchRepo.updateStatus(matchId, MATCH_STATUS.VOTING);
  }

  // Reply confirming their vote
  await interaction.reply({
    content: `You (Team ${captainNumber} captain) voted that **Team ${votedTeam}** won. Waiting for the other captain's vote.`,
    ephemeral: true,
  });

  // Re-fetch match to get updated votes
  const updatedMatch = matchRepo.findById(matchId);
  const captain1Vote = captainNumber === 1 ? votedTeam : updatedMatch.captain1_vote;
  const captain2Vote = captainNumber === 2 ? votedTeam : updatedMatch.captain2_vote;

  // Check if both captains have voted
  if (captain1Vote !== null && captain2Vote !== null) {
    // Clear any vote deadline timer
    const existingTimer = voteTimers.get(matchId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      voteTimers.delete(matchId);
    }

    if (captain1Vote === captain2Vote) {
      // Both voted the same team — resolve match immediately
      try {
        await matchService.resolveMatch(interaction.client, matchId, captain1Vote);

        // Notify in the voting channel
        try {
          const voteChannel = interaction.channel;
          if (voteChannel) {
            await voteChannel.send({
              content: `Both captains agree: **Team ${captain1Vote} wins!** Match resolved.`,
            });
          }
        } catch (err) {
          console.error(`[CaptainVote] Failed to send resolution message:`, err.message);
        }
      } catch (err) {
        console.error(`[CaptainVote] Failed to resolve match #${matchId}:`, err);
      }
    } else {
      // Votes disagree — dispute
      matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
      challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

      // Notify in shared channel
      try {
        if (updatedMatch.shared_text_id) {
          const sharedChannel = interaction.client.channels.cache.get(updatedMatch.shared_text_id);
          if (sharedChannel) {
            const adminRoleId = process.env.ADMIN_ROLE_ID;
            const adminPing = adminRoleId ? `<@&${adminRoleId}>` : 'Admins';

            const resolveRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`admin_resolve_team1_${matchId}`)
                .setLabel('Team 1 Wins')
                .setStyle(ButtonStyle.Primary),
              new ButtonBuilder()
                .setCustomId(`admin_resolve_team2_${matchId}`)
                .setLabel('Team 2 Wins')
                .setStyle(ButtonStyle.Danger),
            );

            await sharedChannel.send({
              content: [
                '**Match Disputed!**',
                '',
                `Captain 1 voted **Team ${captain1Vote}**, Captain 2 voted **Team ${captain2Vote}**.`,
                '',
                `${adminPing} — click a button below to resolve this dispute.`,
              ].join('\n'),
              components: [resolveRow],
            });
          }
        }
      } catch (err) {
        console.error(`[CaptainVote] Failed to send dispute notification:`, err.message);
      }

      // Also notify in the voting channel
      try {
        const voteChannel = interaction.channel;
        if (voteChannel) {
          await voteChannel.send({
            content: `Votes do not match. Captain 1 voted **Team ${captain1Vote}**, Captain 2 voted **Team ${captain2Vote}**. The match is now **disputed** and will be reviewed by an admin.`,
          });
        }
      } catch (err) {
        console.error(`[CaptainVote] Failed to send dispute message in vote channel:`, err.message);
      }
    }
  } else {
    // Only one captain has voted — start the 2-hour deadline timer
    if (!voteTimers.has(matchId)) {
      const timer = setTimeout(async () => {
        voteTimers.delete(matchId);

        try {
          // Re-fetch match to check if other captain voted in the meantime
          const currentMatch = matchRepo.findById(matchId);
          if (!currentMatch) return;

          // If match is already completed or disputed, skip
          if (currentMatch.status === MATCH_STATUS.COMPLETED || currentMatch.status === MATCH_STATUS.DISPUTED) {
            return;
          }

          const c1Vote = currentMatch.captain1_vote;
          const c2Vote = currentMatch.captain2_vote;

          // If both have voted by now (handled above), skip
          if (c1Vote !== null && c2Vote !== null) return;

          // Only one vote exists — that team wins by default
          let winningTeam;
          if (c1Vote !== null && c2Vote === null) {
            winningTeam = c1Vote;
          } else if (c2Vote !== null && c1Vote === null) {
            winningTeam = c2Vote;
          } else {
            // Neither voted (shouldn't happen since timer starts on first vote)
            return;
          }

          console.log(`[CaptainVote] Vote deadline expired for match #${matchId}. Resolving with team ${winningTeam} (only vote).`);

          // Notify in voting channel
          try {
            if (currentMatch.voting_channel_id) {
              const voteChannel = interaction.client.channels.cache.get(currentMatch.voting_channel_id);
              if (voteChannel) {
                await voteChannel.send({
                  content: `**Vote deadline expired.** Only one captain voted. **Team ${winningTeam}** wins by default.`,
                });
              }
            }
          } catch (err) {
            console.error(`[CaptainVote] Failed to send deadline message:`, err.message);
          }

          await matchService.resolveMatch(interaction.client, matchId, winningTeam);
        } catch (err) {
          console.error(`[CaptainVote] Error handling vote deadline for match #${matchId}:`, err);
        }
      }, TIMERS.CAPTAIN_VOTE_DEADLINE);

      voteTimers.set(matchId, timer);
      console.log(`[CaptainVote] Started ${TIMERS.CAPTAIN_VOTE_DEADLINE / 60000}-minute vote deadline timer for match #${matchId}`);
    }
  }
}

module.exports = { handleButton };
