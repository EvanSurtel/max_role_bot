module.exports = {
  intro: {
    title: '🏆 Rangi',
    description: [
      'Każdy gracz jest przypisany do rangi na podstawie swojego **XP sezonu**. Im więcej XP zdobędziesz, tym wyżej się wspinasz.',
      '',
      'XP przychodzi z trzech źródeł — **meczów z kolejki XP**, **wyzwań XP** i **wygranych zakładów**. Wszystko liczy się do twojego totalu XP sezonu.',
      '',
      '**Każdy nowy sezon wszyscy resetują się do 500 XP i zaczynają się wspinać od nowa.** Twoje zarobki z całego życia zostają, ale ranga to świeża walka co sezon.',
      '',
      'Oto osiem rang, które możesz osiągnąć, od najniższej do najwyższej:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ jest używane dla najwyższej rangi, która nie ma sufitu
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Używane dla rang opartych na pozycji (np. Koronowany = top 10)
  range_top: 'Top {n} graczy',

  bronze: {
    name: 'Brąz',
    blurb: 'Tu każdy zaczyna każdy sezon. Wygraj parę meczów żeby się stąd wyrwać.',
  },
  silver: {
    name: 'Srebro',
    blurb: 'Utrzymujesz się. Dalej zbieraj wygrane.',
  },
  gold: {
    name: 'Złoto',
    blurb: 'Ponad średnią. Wiesz co robisz.',
  },
  platinum: {
    name: 'Platyna',
    blurb: 'Poważny konkurent. Mało graczy tu dociera.',
  },
  diamond: {
    name: 'Diament',
    blurb: 'Najwyższa liga. Jesteś teraz w grupie elity.',
  },
  sentinel: {
    name: 'Strażnik',
    blurb: 'Doświadczony weteran. Ludzie znają twoje imię.',
  },
  obsidian: {
    name: 'Obsydian',
    blurb: 'Rzadkie powietrze. Docierają tu tylko najbardziej oddani.',
  },
  crowned: {
    name: 'Koronowany',
    blurb: 'Top 10 graczy z sezonowego leaderboardu XP. Korona oparta na pozycji — ktoś musi ją stracić, żebyś ty ją zdobył.',
  },
};
