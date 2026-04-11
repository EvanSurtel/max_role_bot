// Team sizes
const TEAM_SIZES = [1, 2, 3, 4, 5];

// Series lengths
const SERIES_LENGTHS = [1, 3, 5, 7];

// Game modes
const GAME_MODES = {
  hp: { label: 'Strictly HP', description: 'All Hardpoint' },
  ctrl: { label: 'Strictly CTRL', description: 'All Control' },
  snd: { label: 'Strictly S&D', description: 'All Search & Destroy' },
  hp_snd: { label: 'HP/S&D', description: 'Hardpoint & Search & Destroy rotation' },
  hp_ctrl: { label: 'HP/CTRL', description: 'Hardpoint & Control rotation' },
  ctrl_snd: { label: 'CTRL/S&D', description: 'Control & Search & Destroy rotation' },
  hp_ctrl_snd: { label: 'HP/CTRL/S&D', description: 'Hardpoint, Control & Search & Destroy rotation' },
};

// Map pools per game mode
const MAP_POOLS = {
  HP: ['Summit', 'Hacienda', 'Combine', 'Takeoff', 'Arsenal'],
  'S&D': ['Tunisia', 'Firing Range', 'Slums', 'Meltdown', 'Coastal'],
  CTRL: ['Raid', 'Standoff', 'Crossroads Strike'],
};

// Estimated duration per map in minutes (for match timers)
const MAP_DURATION_MINUTES = {
  HP: 12,
  'S&D': 35,  // CODM: first to 9 wins, max 17 rounds (~2 min/round), overtime 20 rounds
  CTRL: 12,
};

// Match timer settings (in minutes)
const MATCH_TIMERS = {
  NO_SHOW: 15,          // Minutes to show up after match creation (CMG standard)
  NO_SHOW_WARNING: 5,   // Extra minutes after no-show alert
  REPORT_WINDOW: 10,    // Minutes to report after estimated match end
  REPORT_BUFFER: 30,    // Minutes after estimate + window before auto-dispute
};

// Minimum minutes before captains can report results (prevents spam)
// TODO: Re-enable for production: 1: 5, 3: 10, 5: 15, 7: 20
const MIN_REPORT_MINUTES = {
  1: 0,    // DISABLED FOR TESTING
  3: 0,
  5: 0,
  7: 0,
};

// Mode rotation orders for series
// Mode rotation orders for series
// Bo1 with mixed modes: random pick. Bo3+: rotate in order.
const MODE_ROTATIONS = {
  hp: (length) => Array(length).fill('HP'),
  ctrl: (length) => Array(length).fill('CTRL'),
  snd: (length) => Array(length).fill('S&D'),
  hp_snd: (length) => {
    const rotation = ['HP', 'S&D'];
    if (length === 1) return [rotation[Math.floor(Math.random() * rotation.length)]];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  hp_ctrl: (length) => {
    const rotation = ['HP', 'CTRL'];
    if (length === 1) return [rotation[Math.floor(Math.random() * rotation.length)]];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  ctrl_snd: (length) => {
    const rotation = ['CTRL', 'S&D'];
    if (length === 1) return [rotation[Math.floor(Math.random() * rotation.length)]];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  hp_ctrl_snd: (length) => {
    const rotation = ['HP', 'CTRL', 'S&D'];
    if (length === 1) return [rotation[Math.floor(Math.random() * rotation.length)]];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
};

// Timers (in milliseconds)
const TIMERS = {
  CHALLENGE_EXPIRY: 60 * 60 * 1000, // 1 hour
  CHALLENGE_EXTEND: 10 * 60 * 1000,
  TEAMMATE_ACCEPT: 10 * 60 * 1000,
  RESULT_RESPONSE: 10 * 60 * 1000,
  NO_SHOW: 10 * 60 * 1000,
  DEPOSIT_POLL_INTERVAL: 30 * 1000,
  MATCH_INACTIVITY: Number(process.env.MATCH_INACTIVITY_HOURS || 24) * 60 * 60 * 1000,
  HEALTH_CHECK_INTERVAL: 10 * 60 * 1000,
};

// SOL thresholds (in lamports)
const MIN_SOL_FOR_GAS = Math.floor(Number(process.env.MIN_SOL_FOR_GAS || 0.005) * 1_000_000_000);
const ESCROW_SOL_WARNING = Math.floor(Number(process.env.ESCROW_SOL_WARNING_THRESHOLD || 0.05) * 1_000_000_000);
const ESCROW_SOL_CRITICAL = Math.floor(Number(process.env.ESCROW_SOL_CRITICAL_THRESHOLD || 0.01) * 1_000_000_000);

// Rate limit cooldowns (in milliseconds)
const COOLDOWNS = {
  CREATE_WAGER: 10_000,
  WITHDRAW: 30_000,
  SUBMIT_EVIDENCE: 5_000,
};

// Solana / USDC
const USDC_DECIMALS = 6;
const USDC_PER_UNIT = 1_000_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// XP Match ELO-based rewards
const XP_MATCH = {
  BASE_WIN: 100,    // Even match win
  BASE_LOSS: 60,    // Even match loss
  MIN_WIN: 50,      // Favorite stomps (minimum reward)
  MAX_WIN: 160,     // Underdog upset (maximum reward)
  MIN_LOSS: 30,     // Loser vs much stronger team (minimum penalty)
  MAX_LOSS: 100,    // Loser upset by much weaker team (maximum penalty)
  ELO_CAP: 1000,    // XP difference where scaling maxes out
};

// Wager XP rewards (scaled by wager amount)
const XP_WAGER = {
  MIN_XP: 100,      // XP for $0.50 wager win
  MAX_XP: 1000,     // XP for $100 wager win
  MIN_WAGER: 0.50,  // Minimum wager in USDC
  MAX_WAGER: 100,   // Maximum wager in USDC
  LOSS_XP: 0,       // No penalty for losing a wager
};

// Rank tiers used by the ranks display panel and (future) rank role sync.
// Each tier is the FLOOR — a player is in tier X if their XP is >= minXp
// and < the next tier's minXp. The highest tier has no upper bound.
//
// The `emblem` filename points at a PNG in src/public/assets/emblems/.
// Drop the PNG there with the exact filename and it auto-renders on
// the ranks panel. Colors are used as the embed sidebar color.
//
// Adjust the minXp values here if you want a different progression —
// everything else (locale text, panel layout, inline language switch)
// picks up the change automatically.
const RANK_TIERS = [
  // Colors are sampled from the dominant accent of each emblem PNG —
  // change a hex here to change the card background wash, top/bottom
  // bars, and tier-name text color in one place. Any 24-bit RGB is
  // valid (0x000000–0xffffff).
  { key: 'bronze',   minXp: 0,     color: 0xa96d2e, emblem: 'bronze.png' },
  { key: 'silver',   minXp: 1000,  color: 0xa8b0b5, emblem: 'silver.png' },
  { key: 'gold',     minXp: 2500,  color: 0xd4a017, emblem: 'gold.png' },
  { key: 'platinum', minXp: 5000,  color: 0x8cbfbd, emblem: 'platinum.png' },
  { key: 'diamond',  minXp: 6000,  color: 0x2eaaff, emblem: 'diamond.png' },
  { key: 'sentinel', minXp: 6750,  color: 0xd81818, emblem: 'sentinal.png' },
  { key: 'obsidian', minXp: 7500,  color: 0x7a2db8, emblem: 'obsidian.png' },
  // Crowned is the top 10 players on the season XP leaderboard —
  // position-based, NOT an XP threshold. topN overrides the XP
  // range display on the ranks panel. The minXp is left in as a
  // fallback so the array stays sorted and future rank-sync logic
  // has something to work with if topN data isn't available.
  { key: 'crowned',  topN: 10, minXp: 999999, color: 0xe8a500, emblem: 'crowned.png' },
];

// Current season identifier
const CURRENT_SEASON = process.env.CURRENT_SEASON || '2026-S1';

// Challenge statuses
const CHALLENGE_STATUS = {
  PENDING_TEAMMATES: 'pending_teammates',
  OPEN: 'open',
  ACCEPTED: 'accepted',
  IN_PROGRESS: 'in_progress',
  VOTING: 'voting',
  COMPLETED: 'completed',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

// Match statuses
const MATCH_STATUS = {
  ACTIVE: 'active',
  VOTING: 'voting',
  COMPLETED: 'completed',
  DISPUTED: 'disputed',
};

// Challenge types
const CHALLENGE_TYPE = {
  WAGER: 'wager',
  XP: 'xp',
};

// Player roles in a challenge
const PLAYER_ROLE = {
  CAPTAIN: 'captain',
  PLAYER: 'player',
};

// Player statuses
const PLAYER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
};

// Transaction types
const TRANSACTION_TYPE = {
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  HOLD: 'hold',
  RELEASE: 'release',
  ESCROW_IN: 'escrow_in',
  DISBURSEMENT: 'disbursement',
};

module.exports = {
  MAP_POOLS,
  MAP_DURATION_MINUTES,
  MATCH_TIMERS,
  MIN_REPORT_MINUTES,
  TEAM_SIZES,
  SERIES_LENGTHS,
  GAME_MODES,
  MODE_ROTATIONS,
  TIMERS,
  USDC_DECIMALS,
  USDC_PER_UNIT,
  LAMPORTS_PER_SOL,
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  MIN_SOL_FOR_GAS,
  ESCROW_SOL_WARNING,
  ESCROW_SOL_CRITICAL,
  COOLDOWNS,
  XP_MATCH,
  XP_WAGER,
  RANK_TIERS,
  CURRENT_SEASON,
  CHALLENGE_STATUS,
  MATCH_STATUS,
  CHALLENGE_TYPE,
  PLAYER_ROLE,
  PLAYER_STATUS,
  TRANSACTION_TYPE,
};
