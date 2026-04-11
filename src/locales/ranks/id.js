module.exports = {
  intro: {
    title: '🏆 Rank',
    description: [
      'Setiap pemain ditempatkan di rank berdasarkan **XP season** mereka. Makin banyak XP yang kamu dapetin, makin tinggi kamu naik.',
      '',
      'XP dateng dari tiga sumber — **match XP queue**, **XP challenge**, dan **menang wager**. Semuanya diitung ke total XP season kamu.',
      '',
      '**Tiap season baru, semua orang direset ke 500 XP dan mulai naik lagi.** Earnings sepanjang masa kamu tetep nyimpen, tapi rank itu pertarungan baru tiap season.',
      '',
      'Ini delapan rank yang bisa kamu capai, dari paling rendah ke paling tinggi:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ dipake buat rank paling tinggi yang nggak ada batas atasnya
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Tempat semua orang mulai tiap season. Menang beberapa match buat keluar dari sini.',
  },
  silver: {
    name: 'Silver',
    blurb: 'Kamu bisa nahan diri. Terus kumpulin kemenangan.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Di atas rata-rata. Kamu tau apa yang kamu lakuin.',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'Kompetitor serius. Cuma sedikit pemain yang sampe sini.',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Kelas atas. Kamu udah masuk kelompok elite sekarang.',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'Veteran yang udah makan asam garam. Orang-orang kenal nama kamu.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Udara tipis. Cuma yang paling ngotot yang nyampe sini.',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'Puncak absolut. Batas atas Rank $.',
  },
};
