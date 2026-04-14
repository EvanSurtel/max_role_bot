module.exports = {
  intro: {
    title: '🏆 Ränge',
    description: [
      'Jeder Spieler wird basierend auf seiner **Season-XP** in einen Rang eingeordnet. Je mehr XP du verdienst, desto höher steigst du auf.',
      '',
      'XP kommt aus drei Quellen — **XP-Queue-Matches**, **XP-Challenges** und **Cash-Match-Siege**. Alles zählt zu deiner Season-XP-Summe.',
      '',
      '**Jede neue Season setzen alle auf 500 XP zurück und fangen wieder an zu klettern.** Deine All-Time-Gewinne bleiben erhalten, aber der Rang ist jede Season ein frischer Kampf.',
      '',
      'Hier sind die acht Ränge, die du erreichen kannst, vom niedrigsten zum höchsten:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ wird für den höchsten Rang verwendet, der keine Obergrenze hat
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Wird für positionsbasierte Ränge verwendet (z.B. Gekrönt = Top 10)
  range_top: 'Top {n} Spieler',

  bronze: {
    name: 'Bronze',
    blurb: 'Wo jeder jede Season anfängt. Gewinn ein paar Matches, um hier rauszukommen.',
  },
  silver: {
    name: 'Silber',
    blurb: 'Du hältst dich. Sammle weiter Siege.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Über dem Durchschnitt. Du weißt, was du tust.',
  },
  platinum: {
    name: 'Platin',
    blurb: 'Ein ernsthafter Konkurrent. Wenige Spieler kommen hierhin.',
  },
  diamond: {
    name: 'Diamant',
    blurb: 'Top-Tier. Du bist jetzt in der Elite-Klasse.',
  },
  sentinel: {
    name: 'Wächter',
    blurb: 'Erfahrener Veteran. Die Leute kennen deinen Namen.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Dünne Luft. Nur die Engagiertesten kommen hierhin.',
  },
  crowned: {
    name: 'Gekrönt',
    blurb: 'Die Top 10 Spieler der Season-XP-Rangliste. Eine positionsbasierte Krone — jemand muss sie verlieren, damit du sie gewinnst.',
  },
};
