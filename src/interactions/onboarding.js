const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const walletManager = require('../solana/walletManager');

/**
 * Handle button interactions for the onboarding TOS flow.
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id === 'tos_accept') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const discordId = interaction.user.id;

      // Create user in DB if not exists
      let user = userRepo.findByDiscordId(discordId);
      if (!user) {
        user = userRepo.create(discordId);
      }

      // Race condition protection: check if already onboarded
      if (user.accepted_tos === 1) {
        await interaction.editReply({
          content: 'You are already onboarded! Head to the wager channel to create or accept challenges.',
        });
        return;
      }

      // Accept TOS
      userRepo.acceptTos(user.id);

      // Check if wallet already exists
      let wallet = walletRepo.findByUserId(user.id);
      if (!wallet) {
        // Generate a new Solana wallet
        const { address, encryptedPrivateKey, iv, tag, salt } = walletManager.generateWallet();

        // Store encrypted private key in DB
        wallet = walletRepo.create({
          userId: user.id,
          solanaAddress: address,
          encryptedPrivateKey,
          encryptionIv: iv,
          encryptionTag: tag,
          encryptionSalt: salt,
        });
      }

      // Send success message with wallet address
      await interaction.editReply({
        content: [
          '**Welcome! You have accepted the Terms of Service.**',
          '',
          'Your Solana wallet has been created:',
          `\`\`\`${wallet.solana_address}\`\`\``,
          '',
          '**To get started:**',
          '1. Send **USDC** (SPL token) to this address for wagers',
          '2. Send a small amount of **SOL** (~$1) for transaction fees',
          '',
          'Head to the wager channel to create or accept challenges!',
        ].join('\n'),
      });

      // Try to delete the onboarding channel after a short delay
      try {
        setTimeout(async () => {
          try {
            await interaction.channel.delete();
          } catch {
            // Channel may already be deleted or bot lacks permissions
          }
        }, 30000);
      } catch {
        // Ignore cleanup errors
      }
    } catch (err) {
      console.error('[Onboarding] Error accepting TOS:', err);
      await interaction.editReply({
        content: 'Something went wrong during onboarding. Please contact an administrator.',
      });
    }
  }

  if (id === 'tos_decline') {
    await interaction.reply({
      content: 'You have declined the Terms of Service. You will not be able to participate in wagers. This channel will be deleted.',
      ephemeral: true,
    });

    try {
      setTimeout(async () => {
        try {
          await interaction.channel.delete();
        } catch {
          // Channel may already be deleted or bot lacks permissions
        }
      }, 5000);
    } catch {
      // Ignore cleanup errors
    }
  }
}

module.exports = { handleButton };
