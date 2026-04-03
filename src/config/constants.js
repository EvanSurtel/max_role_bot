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

// Mode rotation orders for series
// For mixed modes, this defines the order maps are played
const MODE_ROTATIONS = {
  hp: (length) => Array(length).fill('HP'),
  ctrl: (length) => Array(length).fill('CTRL'),
  snd: (length) => Array(length).fill('S&D'),
  hp_snd: (length) => {
    const rotation = ['HP', 'S&D'];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  hp_ctrl: (length) => {
    const rotation = ['HP', 'CTRL'];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  ctrl_snd: (length) => {
    const rotation = ['CTRL', 'S&D'];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
  hp_ctrl_snd: (length) => {
    const rotation = ['HP', 'CTRL', 'S&D'];
    return Array.from({ length }, (_, i) => rotation[i % rotation.length]);
  },
};

// Timers (in milliseconds)
const TIMERS = {
  CHALLENGE_EXPIRY: 10 * 60 * 1000,       // 10 minutes
  CHALLENGE_EXTEND: 10 * 60 * 1000,       // +10 minutes per extend
  TEAMMATE_ACCEPT: 10 * 60 * 1000,        // 10 minutes to accept
  RESULT_RESPONSE: 10 * 60 * 1000,        // 10 minutes for opponent to accept/dispute
  NO_SHOW: 10 * 60 * 1000,                // 10 minutes
  DEPOSIT_POLL_INTERVAL: 30 * 1000,        // 30 seconds
  MATCH_INACTIVITY: Number(process.env.MATCH_INACTIVITY_HOURS || 24) * 60 * 60 * 1000,
  HEALTH_CHECK_INTERVAL: 10 * 60 * 1000,  // 10 minutes
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
const USDC_PER_UNIT = 1_000_000; // 1 USDC = 1,000,000 smallest units
const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

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

// XP rewards
const XP_WIN = 100;
const XP_LOSS = -60;

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
  CHALLENGE_STATUS,
  MATCH_STATUS,
  CHALLENGE_TYPE,
  PLAYER_ROLE,
  PLAYER_STATUS,
  XP_WIN,
  XP_LOSS,
  TRANSACTION_TYPE,
};
