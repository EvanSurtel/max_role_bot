module.exports = {
  intro: {
    title: '🏆 Ranks',
    description: [
      'Cada jogador é colocado em um rank baseado no seu **XP da temporada**. Quanto mais XP você ganha, mais alto você sobe.',
      '',
      'O XP vem de três fontes — **partidas da fila de XP**, **desafios de XP** e **vitórias em apostas**. Tudo conta pro seu total de XP da temporada.',
      '',
      '**A cada nova temporada, todo mundo reseta pra 500 XP e começa a subir de novo.** Seus ganhos de todos os tempos continuam, mas o rank é briga nova a cada temporada.',
      '',
      'Aqui estão os oito ranks que você pode alcançar, do mais baixo ao mais alto:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ é usado pro rank mais alto que não tem teto
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Onde todo mundo começa a cada temporada. Vença algumas partidas pra sair daqui.',
  },
  silver: {
    name: 'Prata',
    blurb: 'Você tá se virando. Continua empilhando vitórias.',
  },
  gold: {
    name: 'Ouro',
    blurb: 'Acima da média. Você sabe o que tá fazendo.',
  },
  platinum: {
    name: 'Platina',
    blurb: 'Competidor sério. Poucos jogadores chegam aqui.',
  },
  diamond: {
    name: 'Diamante',
    blurb: 'Top de linha. Você tá na elite agora.',
  },
  sentinel: {
    name: 'Sentinela',
    blurb: 'Veterano experiente. O pessoal conhece teu nome.',
  },
  obsidian: {
    name: 'Obsidiana',
    blurb: 'Ar rarefeito. Só os mais dedicados chegam aqui.',
  },
  crowned: {
    name: 'Coroado',
    blurb: 'O topo absoluto. O teto do Rank $.',
  },
};
