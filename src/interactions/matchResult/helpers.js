// Shared helpers for match result handling.

/**
 * Check if a member has dispute resolution permissions (ads, CEO,
 * owner, admin, or match/XP staff). Ads, CEO, and owner have the
 * same powers as admin everywhere in the bot.
 *
 * @param {import('discord.js').GuildMember} member
 * @returns {boolean}
 */
function canResolveDisputes(member) {
  const adsRoleId = process.env.ADS_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
  const xpStaffId = process.env.XP_STAFF_ROLE_ID;
  if (adsRoleId && member.roles.cache.has(adsRoleId)) return true;
  if (ceoRoleId && member.roles.cache.has(ceoRoleId)) return true;
  if (ownerRoleId && member.roles.cache.has(ownerRoleId)) return true;
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (wagerStaffId && member.roles.cache.has(wagerStaffId)) return true;
  if (xpStaffId && member.roles.cache.has(xpStaffId)) return true;
  return false;
}

module.exports = { canResolveDisputes };
