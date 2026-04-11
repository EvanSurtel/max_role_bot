module.exports = {
  intro: {
    title: '🏆 Ranks',
    description: [
      'Elke speler wordt in een rank geplaatst op basis van zijn **season XP**. Hoe meer XP je verdient, hoe hoger je klimt.',
      '',
      'XP komt van drie bronnen — **XP queue matches**, **XP challenges** en **wager winsten**. Alles telt op bij je season XP totaal.',
      '',
      '**Elk nieuw seizoen reset iedereen naar 500 XP en begint opnieuw te klimmen.** Je all-time verdiensten blijven staan, maar rank is elk seizoen een frisse strijd.',
      '',
      'Hier zijn de acht ranks die je kunt bereiken, van laagste tot hoogste:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ wordt gebruikt voor de hoogste rank die geen plafond heeft
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Gebruikt voor positie-gebaseerde ranks (bijv. Gekroond = top 10)
  range_top: 'Top {n} spelers',

  bronze: {
    name: 'Brons',
    blurb: 'Waar iedereen elk seizoen begint. Win een paar matches om eruit te breken.',
  },
  silver: {
    name: 'Zilver',
    blurb: 'Je houdt jezelf staande. Blijf winsten stapelen.',
  },
  gold: {
    name: 'Goud',
    blurb: 'Bovengemiddeld. Je weet wat je doet.',
  },
  platinum: {
    name: 'Platina',
    blurb: 'Een serieuze concurrent. Weinig spelers komen hier.',
  },
  diamond: {
    name: 'Diamant',
    blurb: 'Top-tier. Je zit nu in de elite klasse.',
  },
  sentinel: {
    name: 'Schildwacht',
    blurb: 'Doorgewinterde veteraan. Mensen kennen je naam.',
  },
  obsidian: {
    name: 'Obsidiaan',
    blurb: 'IJle lucht. Alleen de meest toegewijden komen hier.',
  },
  crowned: {
    name: 'Gekroond',
    blurb: 'De top 10 spelers van het season XP leaderboard. Een positie-gebaseerde kroon — iemand moet hem verliezen voordat jij hem kunt winnen.',
  },
};
