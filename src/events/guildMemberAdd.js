const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../base/walletManager');
const { syncRank } = require('../utils/rankRoleSync');

// Concurrency cap on join-time wallet creation. Matches the cap used
// by src/interactions/onboarding.js so a raid / mass-join doesn't
// blow through CDP's wallet-creation rate limit.
const MAX_CONCURRENT_AUTO_WALLETS = 3;
let _activeAutoWallets = 0;

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

    // Auto-provision a CDP Smart Account for every new member.
    //
    // Why: the Coinbase CDP review team needs to exercise the full
    // deposit / cashout flow in the review demo channel. Our real
    // registration requires a COD Mobile UID / IGN (which Coinbase
    // staff don't have), so we can't gate the wallet behind that
    // form. Auto-creating on join means anyone who opens the demo
    // channel and clicks "View My Wallet" has a wallet ready — same
    // end-to-end flow a real user sees, minus the COD fields.
    //
    // For real players: completing full onboarding later still
    // works — userRepo.create is idempotent (discord_id UNIQUE), the
    // onboarding flow finds the existing user row and fills in the
    // COD fields + accepted_tos in the UPDATE statement. The wallet
    // created here is kept (not re-created), since walletRepo.create
    // is also only called if findByUserId returns null.
    //
    // Bots (other Discord apps joining the server) are skipped.
    if (member.user.bot) return;

    try {
      let user = userRepo.findByDiscordId(member.user.id);
      if (user) {
        const existingWallet = walletRepo.findByUserId(user.id);
        if (existingWallet) return; // rejoin, wallet already present
      } else {
        user = userRepo.create(member.user.id);
      }

      if (_activeAutoWallets >= MAX_CONCURRENT_AUTO_WALLETS) {
        console.warn(`[GuildMemberAdd] Concurrency cap hit — skipping auto-wallet for ${member.user.tag}. They can still create one via full onboarding.`);
        return;
      }
      _activeAutoWallets++;
      try {
        const walletData = await walletManager.generateWallet(user.id);
        walletRepo.create({
          userId: user.id,
          address: walletData.address,
          accountRef: walletData.accountRef,
          smartAccountRef: walletData.smartAccountRef,
        });
        console.log(`[GuildMemberAdd] Auto-wallet created for ${member.user.tag}: ${walletData.address}`);
      } finally {
        _activeAutoWallets--;
      }
    } catch (err) {
      console.error(`[GuildMemberAdd] Auto-wallet creation failed for ${member.user.tag}: ${err.message}`);
    }
  },
};
