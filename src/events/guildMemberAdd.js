const userRepo = require('../database/repositories/userRepo');
const { syncRank } = require('../utils/rankRoleSync');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    // No dynamic welcome channel — TOS panel lives in the static WELCOME_CHANNEL_ID.
    // New members see it because @everyone has view access to that channel.
    console.log(`[GuildMemberAdd] ${member.user.tag} joined the server`);

    // Rejoiners: restore their rank role immediately. Discord strips
    // all server roles when a user leaves, so a returning player
    // would be rankless until they played another match (which
    // triggers syncRanks) unless we resync here. Users who never
    // registered (accepted_tos=0) or who aren't in the DB at all
    // are skipped inside syncRank() so this is a safe no-op for
    // genuinely-new members.
    try {
      const user = userRepo.findByDiscordId(member.user.id);
      if (user && user.accepted_tos === 1) {
        await syncRank(member.client, user.id);
      }
    } catch (err) {
      console.error(`[GuildMemberAdd] Rank resync failed for ${member.user.tag}:`, err.message);
    }
  },
};
