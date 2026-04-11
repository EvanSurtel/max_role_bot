module.exports = {
  intro: {
    title: '🏆 Ranks',
    description: [
      'हर player को उसके **season XP** के हिसाब से rank में रखा जाता है। जितना ज्यादा XP तुम कमाओगे, उतना ऊपर चढ़ोगे।',
      '',
      'XP तीन sources से आता है — **XP queue matches**, **XP challenges**, और **wager wins**। सब तुम्हारे season XP total में add होता है।',
      '',
      '**हर नए season में सब लोग 500 XP पर reset हो जाते हैं और फिर से चढ़ना शुरू करते हैं।** तुम्हारे all-time earnings carry over होते हैं, लेकिन rank हर season एक fresh fight है।',
      '',
      'ये आठ ranks हैं जिन तक तुम पहुंच सकते हो, सबसे नीचे से सबसे ऊपर तक:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ सबसे ऊंचे rank के लिए use होता है जिसकी कोई ceiling नहीं है
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Position-based ranks के लिए use होता है (जैसे Crowned = top 10)
  range_top: 'Top {n} players',

  bronze: {
    name: 'Bronze',
    blurb: 'जहां हर कोई हर season शुरू करता है। यहां से निकलने के लिए कुछ matches जीतो।',
  },
  silver: {
    name: 'Silver',
    blurb: 'तुम अपनी जगह बना रहे हो। wins stack करते रहो।',
  },
  gold: {
    name: 'Gold',
    blurb: 'Average से ऊपर। तुम्हें पता है तुम क्या कर रहे हो।',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'एक serious competitor। बहुत कम players यहां तक पहुंचते हैं।',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Top-tier। तुम अब elite bracket में हो।',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'तजुर्बेकार veteran। लोग तुम्हारा नाम जानते हैं।',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'दुर्लभ हवा। सिर्फ सबसे dedicated लोग यहां पहुंचते हैं।',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'Season XP leaderboard के top 10 players। Position-based crown — किसी को इसे खोना पड़ेगा तभी तुम इसे पा सकते हो।',
  },
};
