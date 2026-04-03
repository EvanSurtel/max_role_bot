module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    // No dynamic welcome channel — TOS panel lives in the static WELCOME_CHANNEL_ID
    // New members see it because @everyone has view access to that channel
    console.log(`[GuildMemberAdd] ${member.user.tag} joined the server`);
  },
};
