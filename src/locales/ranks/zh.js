module.exports = {
  intro: {
    title: '🏆 段位',
    description: [
      '每个玩家都会根据自己的**赛季 XP** 被分配到一个段位。XP 赚得越多,段位爬得越高。',
      '',
      'XP 来自三个来源 —— **XP 队列比赛**、**XP 挑战**和**押注获胜**。全部都会计入你的赛季 XP 总分。',
      '',
      '**每个新赛季所有人都重置为 500 XP,重新开始往上爬。** 你的历来收益会保留,但段位每个赛季都是全新的战斗。',
      '',
      '下面是你能达到的八个段位,从最低到最高:',
    ].join('\n'),
  },

  rank_title: '{name} — {range}',

  // {min}+ 用于没有上限的最高段位
  range_open: '{min}+ XP',
  range_band: '{min} – {max} XP',
  // 用于基于排名的段位(例如加冕 = 前 10 名)
  range_top: '前 {n} 名玩家',

  bronze: {
    name: '青铜',
    blurb: '每个赛季所有人的起点。赢几场比赛就能脱离这里。',
  },
  silver: {
    name: '白银',
    blurb: '你站得住脚。继续累积胜场。',
  },
  gold: {
    name: '黄金',
    blurb: '高于平均水准。你知道自己在做什么。',
  },
  platinum: {
    name: '铂金',
    blurb: '认真的竞争者。能到这里的玩家不多。',
  },
  diamond: {
    name: '钻石',
    blurb: '顶级水平。你已经在精英行列了。',
  },
  sentinel: {
    name: '哨兵',
    blurb: '身经百战的老将。人们都知道你的名字。',
  },
  obsidian: {
    name: '黑曜石',
    blurb: '稀薄空气。只有最专注的人能到达这里。',
  },
  crowned: {
    name: '加冕',
    blurb: '赛季 XP 排行榜前 10 名的玩家。一个基于排名的王冠 —— 得有人失去它,你才能得到它。',
  },
};
