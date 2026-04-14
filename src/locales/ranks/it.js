module.exports = {
  intro: {
    title: '🏆 Ranghi',
    description: [
      'Ogni giocatore viene inserito in un rango in base al suo **XP di stagione**. Più XP guadagni, più sali.',
      '',
      'L\'XP arriva da tre fonti — **match in coda XP**, **sfide XP** e **vittorie in cash match**. Tutto conta per il tuo totale XP di stagione.',
      '',
      '**A ogni nuova stagione, tutti ripartono da 500 XP e ricominciano a salire.** I tuoi guadagni di sempre restano, ma il rango è una battaglia nuova a ogni stagione.',
      '',
      'Ecco gli otto ranghi che puoi raggiungere, dal più basso al più alto:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ è usato per il rango più alto che non ha tetto
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // Usato per ranghi basati sulla posizione (es., Incoronato = top 10)
  range_top: 'Top {n} giocatori',

  bronze: {
    name: 'Bronzo',
    blurb: 'Dove tutti iniziano ogni stagione. Vinci qualche match per uscirne.',
  },
  silver: {
    name: 'Argento',
    blurb: 'Te la cavi. Continua ad accumulare vittorie.',
  },
  gold: {
    name: 'Oro',
    blurb: 'Sopra la media. Sai quello che fai.',
  },
  platinum: {
    name: 'Platino',
    blurb: 'Un serio competitor. Pochi giocatori arrivano qui.',
  },
  diamond: {
    name: 'Diamante',
    blurb: 'Top assoluto. Sei nella fascia elite adesso.',
  },
  sentinel: {
    name: 'Sentinella',
    blurb: 'Veterano navigato. La gente conosce il tuo nome.',
  },
  obsidian: {
    name: 'Ossidiana',
    blurb: 'Aria rarefatta. Solo i più dediti arrivano qui.',
  },
  crowned: {
    name: 'Incoronato',
    blurb: 'I 10 migliori giocatori della classifica XP di stagione. Una corona basata sulla posizione — qualcuno deve perderla perché tu possa guadagnarla.',
  },
};
