module.exports = {
  intro: {
    title: '🏆 Rangs',
    description: [
      'Chaque joueur est placé dans un rang selon son **XP de saison**. Plus vous gagnez d\'XP, plus vous montez.',
      '',
      'L\'XP vient de trois sources — **matchs en file XP**, **défis XP** et **victoires en mise**. Tout compte dans votre total d\'XP de saison.',
      '',
      '**À chaque nouvelle saison, tout le monde repart à 500 XP et recommence à grimper.** Vos gains à vie sont conservés, mais le rang est une nouvelle bataille chaque saison.',
      '',
      'Voici les huit rangs que vous pouvez atteindre, du plus bas au plus haut :',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ est utilisé pour le rang le plus haut qui n'a pas de plafond
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Utilisé pour les rangs basés sur la position (ex., Couronné = top 10)
  range_top: 'Top {n} joueurs',

  bronze: {
    name: 'Bronze',
    blurb: 'Là où tout le monde commence chaque saison. Gagnez quelques matchs pour en sortir.',
  },
  silver: {
    name: 'Argent',
    blurb: 'Vous tenez votre place. Continuez à enchaîner les victoires.',
  },
  gold: {
    name: 'Or',
    blurb: 'Au-dessus de la moyenne. Vous savez ce que vous faites.',
  },
  platinum: {
    name: 'Platine',
    blurb: 'Un compétiteur sérieux. Peu de joueurs arrivent ici.',
  },
  diamond: {
    name: 'Diamant',
    blurb: 'Haut du panier. Vous êtes dans l\'élite maintenant.',
  },
  sentinel: {
    name: 'Sentinelle',
    blurb: 'Vétéran aguerri. Les gens connaissent votre nom.',
  },
  obsidian: {
    name: 'Obsidienne',
    blurb: 'Air raréfié. Seuls les plus dévoués arrivent jusque là.',
  },
  crowned: {
    name: 'Couronné',
    blurb: 'Les 10 meilleurs joueurs du classement XP de la saison. Une couronne basée sur la position — quelqu\'un doit la perdre pour que vous la gagniez.',
  },
};
