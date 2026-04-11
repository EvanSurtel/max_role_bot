module.exports = {
  intro: {
    title: '🏆 Ranks',
    description: [
      'Every player is placed into a rank based on their **season XP**. The more XP you earn, the higher you climb.',
      '',
      'XP comes from three sources — **XP queue matches**, **XP challenges**, and **wager wins**. All of it counts toward your season XP total.',
      '',
      '**Every new season, everyone resets to 500 XP and starts climbing again.** Your all-time earnings carry over, but rank is a fresh fight each season.',
      '',
      'Here are the eight ranks you can reach, from lowest to highest:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ is used for the highest rank which has no ceiling
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Where everyone starts each season. Win a few matches to break out.',
  },
  silver: {
    name: 'Silver',
    blurb: 'You\'re holding your own. Keep stacking wins.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Above average. You know what you\'re doing.',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'A serious competitor. Few players reach here.',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Top-tier. You\'re in the elite bracket now.',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'Seasoned veteran. People know your name.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Rare air. Only the most dedicated get here.',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'The absolute top. The ceiling of Rank $.',
  },
};
