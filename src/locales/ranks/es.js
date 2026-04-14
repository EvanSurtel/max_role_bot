module.exports = {
  intro: {
    title: '🏆 Rangos',
    description: [
      'Cada jugador entra a un rango según su **XP de temporada**. Entre más XP ganes, más alto subes.',
      '',
      'El XP viene de tres fuentes — **partidas de XP queue**, **retos de XP** y **victorias en cash match**. Todo suma a tu total de XP de temporada.',
      '',
      '**Cada temporada nueva, todos reinician a 500 XP y empiezan a subir otra vez.** Tus ganancias de por vida se mantienen, pero el rango es pelea nueva cada temporada.',
      '',
      'Estos son los ocho rangos que puedes alcanzar, del más bajo al más alto:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ se usa para el rango más alto que no tiene techo
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Usado para rangos basados en posición (ej., Coronado = top 10)
  range_top: 'Top {n} jugadores',

  bronze: {
    name: 'Bronce',
    blurb: 'Donde todos empiezan cada temporada. Gana unas cuantas partidas para salir de aquí.',
  },
  silver: {
    name: 'Plata',
    blurb: 'Te la llevas bien. Sigue acumulando victorias.',
  },
  gold: {
    name: 'Oro',
    blurb: 'Arriba del promedio. Ya sabes lo que haces.',
  },
  platinum: {
    name: 'Platino',
    blurb: 'Competidor serio. Pocos jugadores llegan hasta aquí.',
  },
  diamond: {
    name: 'Diamante',
    blurb: 'Élite total. Ya estás en el grupo de los grandes.',
  },
  sentinel: {
    name: 'Centinela',
    blurb: 'Veterano curtido. La gente conoce tu nombre.',
  },
  obsidian: {
    name: 'Obsidiana',
    blurb: 'Aire raro. Solo los más dedicados llegan aquí.',
  },
  crowned: {
    name: 'Coronado',
    blurb: 'Los 10 mejores jugadores del leaderboard de XP de la temporada. Una corona basada en posición — alguien tiene que perderla para que tú la ganes.',
  },
};
