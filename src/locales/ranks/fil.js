module.exports = {
  intro: {
    title: '🏆 Ranks',
    description: [
      'Bawat player ay ilalagay sa isang rank base sa kanilang **season XP**. Habang mas marami kang nakukuhang XP, mas mataas kang umaakyat.',
      '',
      'Ang XP ay galing sa tatlong source — **XP queue matches**, **XP challenges**, at **panalong wagers**. Lahat ay bibilang sa kabuuang season XP mo.',
      '',
      '**Bawat bagong season, nagre-reset ang lahat sa 500 XP at nagsisimulang umakyat muli.** Ang all-time earnings mo ay mananatili, pero ang rank ay sariwang laban bawat season.',
      '',
      'Narito ang walong ranks na maaabot mo, mula pinakamababa hanggang pinakamataas:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ ay ginagamit para sa pinakamataas na rank na walang hangganan
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Kung saan nagsisimula ang lahat bawat season. Manalo ng ilang matches para makaalis dito.',
  },
  silver: {
    name: 'Silver',
    blurb: 'Kaya mo ang ganap. Patuloy na magtago ng mga panalo.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Higit sa karaniwan. Alam mo ang ginagawa mo.',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'Seryosong kalaban. Kakaunti lang na players ang nakakarating dito.',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Top-tier. Nasa elite bracket ka na ngayon.',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'Beteranong matagumpay. Kilala ka na ng mga tao.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Manipis na hangin. Tanging pinakadedikado lamang ang nakakarating dito.',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'Ang pinakatuktok. Ang kisame ng Rank $.',
  },
};
