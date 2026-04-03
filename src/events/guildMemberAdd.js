module.exports = {
  name: 'guildMemberAdd',
  async execute(member) {
    const onboardingService = require('../services/onboardingService');
    try {
      await onboardingService.startOnboarding(member);
    } catch (err) {
      console.error(`[GuildMemberAdd] Failed to start onboarding for ${member.user.tag}:`, err);
    }
  },
};
