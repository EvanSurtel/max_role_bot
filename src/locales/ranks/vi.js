module.exports = {
  intro: {
    title: '🏆 Rank',
    description: [
      'Mỗi người chơi được đặt vào một rank dựa trên **XP season** của họ. Càng kiếm được nhiều XP, bạn càng leo cao.',
      '',
      'XP đến từ ba nguồn — **match XP queue**, **XP challenge**, và **thắng wager**. Tất cả đều được cộng vào tổng XP season của bạn.',
      '',
      '**Mỗi season mới, tất cả mọi người reset về 500 XP và bắt đầu leo lại.** Thu nhập mọi thời đại của bạn được giữ lại, nhưng rank là một cuộc chiến mới mỗi season.',
      '',
      'Đây là tám rank bạn có thể đạt được, từ thấp nhất đến cao nhất:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ được dùng cho rank cao nhất không có trần
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',

  bronze: {
    name: 'Bronze',
    blurb: 'Nơi mọi người bắt đầu mỗi season. Thắng vài match để thoát ra.',
  },
  silver: {
    name: 'Silver',
    blurb: 'Bạn trụ vững được. Cứ tiếp tục gom chiến thắng.',
  },
  gold: {
    name: 'Gold',
    blurb: 'Trên mức trung bình. Bạn biết mình đang làm gì.',
  },
  platinum: {
    name: 'Platinum',
    blurb: 'Đối thủ đáng gờm. Ít người chơi lên được tới đây.',
  },
  diamond: {
    name: 'Diamond',
    blurb: 'Hạng top. Bạn đang ở nhóm elite rồi.',
  },
  sentinel: {
    name: 'Sentinel',
    blurb: 'Kỳ cựu dày dạn. Người ta biết tên bạn.',
  },
  obsidian: {
    name: 'Obsidian',
    blurb: 'Không khí loãng. Chỉ những người tận tụy nhất mới lên được đây.',
  },
  crowned: {
    name: 'Crowned',
    blurb: 'Đỉnh tuyệt đối. Trần của Rank $.',
  },
};
