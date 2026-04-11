module.exports = {
  intro: {
    title: '🏆 Rank',
    description: [
      'Setiap pemain ditempatkan dalam rank berdasarkan **XP season** mereka. Lagi banyak XP yang kamu dapat, lagi tinggi kamu naik.',
      '',
      'XP datang dari tiga sumber — **match XP queue**, **XP challenge**, dan **menang wager**. Semua dikira ke total XP season kamu.',
      '',
      '**Setiap season baru, semua orang reset ke 500 XP dan mula mendaki semula.** Earnings sepanjang masa kamu dikekalkan, tapi rank adalah pertarungan baru setiap season.',
      '',
      'Ini lapan rank yang kamu boleh capai, dari paling rendah ke paling tinggi:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ digunakan untuk rank paling tinggi yang tiada had atas
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Tempat semua orang mula setiap season. Menang beberapa match untuk keluar dari sini.',
  },
  silver: {
    name: 'Silver',
    blurb: 'Kamu boleh bertahan. Teruskan kumpul kemenangan.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Atas purata. Kamu tahu apa yang kamu buat.',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'Pesaing yang serius. Sedikit saja pemain yang sampai di sini.',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Tahap teratas. Kamu dah dalam kumpulan elite sekarang.',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'Veteran berpengalaman. Orang kenal nama kamu.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Udara nipis. Hanya yang paling tekun sampai ke sini.',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'Puncak mutlak. Had atas Rank $.',
  },
};
