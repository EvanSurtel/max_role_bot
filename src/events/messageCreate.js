// Message-based prefix commands.
//
// Complements the slash command router in interactionCreate.js.
// Some commands read better as raw text the user types into chat
// (e.g. `/rank @player` showing a rank card). Slash commands would
// force a `player:@user` option label into the rendered message —
// this handler parses the text before Discord's slash command UI
// gets a chance to label it.
//
// Requires the Message Content gateway intent (enabled in
// src/index.js) AND the "Message Content Intent" toggle in the
// Discord Developer Portal for the bot application.
//
// Supported commands:
//   /rank              → your own rank card
//   /rank @player      → that player's rank card

const { buildRankCard } = require('../commands/rank');
const { langFor } = require('../locales/i18n');

// Match a command at the very start of the message, optionally
// followed by whitespace + anything else. Case-insensitive. Anchored
// so `/rank` must be the first token — avoids firing on messages
// that just happen to contain "/rank" inside them.
const RANK_CMD = /^\/rank\b/i;

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    try {
      // Ignore bots (including ourselves) and DMs
      if (message.author.bot) return;
      if (!message.guild) return;

      const content = (message.content || '').trim();
      if (!content) return;

      if (RANK_CMD.test(content)) {
        return handleRankCommand(message);
      }

      // Drop in additional prefix-commands here as they're added.
    } catch (err) {
      console.error('[MessageCreate] Handler error:', err);
    }
  },
};

async function handleRankCommand(message) {
  // First mentioned user, or the sender if nobody was @'d
  const target = message.mentions.users.first() || message.author;
  const lang = langFor({ user: message.author, member: message.member, locale: message.guild?.preferredLocale });

  // Show "bot is typing" so the user sees something is happening
  // while we round-trip to NeatQueue.
  try { await message.channel.sendTyping(); } catch { /* ignore */ }

  const result = await buildRankCard(target, lang);
  if (result.kind === 'error') {
    return message.reply({
      content: result.content,
      allowedMentions: { repliedUser: false },
    });
  }
  return message.reply({
    embeds: result.embeds,
    files: result.files,
    allowedMentions: { repliedUser: false },
  });
}
