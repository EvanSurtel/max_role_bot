module.exports = {
  intro: {
    title: '🏆 Rütbeler',
    description: [
      'Her oyuncu **sezon XP**\'sine göre bir rütbeye yerleştirilir. Ne kadar çok XP kazanırsan, o kadar yükseğe tırmanırsın.',
      '',
      'XP üç kaynaktan gelir — **XP queue maçları**, **XP challenge\'lar** ve **wager zaferleri**. Hepsi sezon XP toplamına eklenir.',
      '',
      '**Her yeni sezon herkes 500 XP\'ye sıfırlanır ve tekrar tırmanmaya başlar.** Tüm zaman kazançların devam eder, ama rütbe her sezon yeni bir savaş.',
      '',
      'İşte ulaşabileceğin sekiz rütbe, düşükten yükseğe:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ tavanı olmayan en yüksek rütbe için kullanılır
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronz',
    blurb: 'Her sezon herkesin başladığı yer. Çıkmak için birkaç maç kazan.',
  },
  silver: {
    name: 'Gümüş',
    blurb: 'Kendi başının çaresine bakıyorsun. Zaferleri yığmaya devam et.',
  },
  gold: {
    name: 'Altın',
    blurb: 'Ortalamanın üstü. Ne yaptığını biliyorsun.',
  },
  platinum: {
    name: 'Platin',
    blurb: 'Ciddi bir rakip. Buraya çok az oyuncu ulaşır.',
  },
  diamond: {
    name: 'Elmas',
    blurb: 'Üst seviye. Artık elit grupta sayılırsın.',
  },
  sentinel: {
    name: 'Muhafız',
    blurb: 'Tecrübeli veteran. İnsanlar adını biliyor.',
  },
  obsidian: {
    name: 'Obsidyen',
    blurb: 'Seyrek hava. Buraya sadece en kararlı olanlar ulaşır.',
  },
  crowned: {
    name: 'Taçlandırılmış',
    blurb: 'Mutlak zirve. Rank $\'ın tavanı.',
  },
};
