const userRepo = require('../database/repositories/userRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const matchRepo = require('../database/repositories/matchRepo');
const challengeService = require('../services/challengeService');
const { CHALLENGE_STATUS, MATCH_STATUS } = require('../config/constants');

// Challenge statuses that are still "forming" and should be auto-cancelled
const FORMING_STATUSES = [
  CHALLENGE_STATUS.PENDING_TEAMMATES,
  CHALLENGE_STATUS.OPEN,
  CHALLENGE_STATUS.ACCEPTED,
];

module.exports = {
  name: 'guildMemberRemove',
  async execute(member) {
    const discordId = member.user.id;
    const tag = member.user.tag;

    try {
      // 1. Look them up in the DB
      const user = userRepo.findByDiscordId(discordId);
      if (!user) {
        console.log(`[GuildMemberRemove] ${tag} left but has no DB record — nothing to clean up`);
        return;
      }

      // 2. Find any challenge_player records for them
      const playerRecords = challengePlayerRepo.findByUserId(user.id);
      if (!playerRecords || playerRecords.length === 0) {
        console.log(`[GuildMemberRemove] ${tag} left but has no active challenge records`);
        return;
      }

      // 3. Process each challenge_player record
      const cancelledIds = [];
      const warnedIds = [];

      for (const playerRecord of playerRecords) {
        const challenge = challengeRepo.findById(playerRecord.challenge_id);
        if (!challenge) continue;

        if (FORMING_STATUSES.includes(challenge.status)) {
          // Challenge is still forming — cancel it
          try {
            await challengeService.cancelChallenge(challenge.id);
            cancelledIds.push(challenge.id);
            console.log(
              `[GuildMemberRemove] Cancelled challenge #${challenge.id} — ${tag} (${playerRecord.role}) left the server`,
            );
          } catch (err) {
            console.error(
              `[GuildMemberRemove] Failed to cancel challenge #${challenge.id}:`,
              err,
            );
          }
        } else if (challenge.status === CHALLENGE_STATUS.IN_PROGRESS) {
          // 4. In-progress match: auto-dispute and create dispute channels
          warnedIds.push(challenge.id);
          try {
            // Find the match for this challenge
            const db = require('../database/db');
            const match = db.prepare('SELECT * FROM matches WHERE challenge_id = ?').get(challenge.id);
            if (match && (match.status === MATCH_STATUS.ACTIVE || match.status === MATCH_STATUS.VOTING)) {
              matchRepo.updateStatus(match.id, MATCH_STATUS.DISPUTED);
              challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.DISPUTED);

              // Notify in shared channel
              if (match.shared_text_id) {
                const sharedChannel = member.client.channels.cache.get(match.shared_text_id);
                if (sharedChannel) {
                  const adminRoleId = process.env.ADMIN_ROLE_ID;
                  const adminPing = adminRoleId ? `<@&${adminRoleId}>` : 'Admins';
                  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

                  const adminRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setCustomId(`admin_resolve_team1_${match.id}`)
                      .setLabel('Team 1 Wins')
                      .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                      .setCustomId(`admin_resolve_team2_${match.id}`)
                      .setLabel('Team 2 Wins')
                      .setStyle(ButtonStyle.Danger),
                  );

                  await sharedChannel.send({
                    content: `**<@${discordId}> has left the server during an active match.**\n\nMatch #${match.id} is now **disputed**.\n\n${adminPing} — please review and resolve this match.`,
                    components: [adminRow],
                  });
                }
              }

              console.warn(`[GuildMemberRemove] ${tag} left during match #${match.id} — auto-disputed`);
            }
          } catch (err) {
            console.error(`[GuildMemberRemove] Error disputing match for challenge #${challenge.id}:`, err.message);
          }
        }
        // Completed, cancelled, expired, etc. — no action needed
      }

      // 5. Summary log
      if (cancelledIds.length > 0 || warnedIds.length > 0) {
        console.log(
          `[GuildMemberRemove] ${tag} left server — cancelled ${cancelledIds.length} challenge(s) [${cancelledIds.join(', ')}], warned on ${warnedIds.length} in-progress [${warnedIds.join(', ')}]`,
        );
      }
    } catch (err) {
      console.error(`[GuildMemberRemove] Error handling member leave for ${tag}:`, err);
    }
  },
};
