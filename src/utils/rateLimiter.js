// Rate limiting + abuse detection.
//
// Three layers of protection on expensive/on-chain-triggering user
// actions:
//
//   1. Per-action cooldowns (time between repeats of same action)
//      — e.g. 10s between match creations.
//   2. Rolling quotas (N actions per window)
//      — e.g. 3 withdrawals per 24h, 10 match entries per 24h.
//   3. Global on-chain cooldown (any on-chain op by same user)
//      — e.g. 60s between ANY two on-chain triggering actions.
//
// Plus: abuse tracking. If one user trips rate limits many times
// within a short window, we ping the admin alerts channel with
// their Discord ID as a griefing signal.
//
// All state is in-memory. Lost on restart — acceptable because any
// persistent abuser hits the limit again on their next attempt.

const { COOLDOWNS, LIMITS } = require('../config/constants');

// ─── State ─────────────────────────────────────────────────────

// cooldowns: Map<userId, Map<action, lastFiredAtMs>>
const userCooldowns = new Map();

// quotas: Map<userId, Map<quotaKey, number[]>> — timestamps of recent hits
const userQuotas = new Map();

// on-chain cooldown: Map<userId, lastOnchainActionMs>
const userOnchainLast = new Map();

// abuse hits: Map<userId, number[]> — timestamps of recent rate-limit blocks
const userAbuseHits = new Map();
// userId → lastAlertAt (to avoid re-alerting every block once flagged)
const userAbuseAlerted = new Map();

// Optional: Discord client, set once at boot so we can post admin alerts
let discordClient = null;
function setClient(client) { discordClient = client; }

// ─── Cooldowns ─────────────────────────────────────────────────

/**
 * Check if a user is on cooldown for a named action.
 * Returns `{ blocked: boolean, remainingSeconds: number }`.
 */
function checkCooldown(userId, action) {
  const cooldownMs = COOLDOWNS[action];
  if (!cooldownMs) return { blocked: false, remainingSeconds: 0 };

  const userMap = userCooldowns.get(userId);
  const lastUsed = userMap ? userMap.get(action) : null;
  if (!lastUsed) return { blocked: false, remainingSeconds: 0 };

  const elapsed = Date.now() - lastUsed;
  if (elapsed >= cooldownMs) {
    userMap.delete(action);
    return { blocked: false, remainingSeconds: 0 };
  }
  return { blocked: true, remainingSeconds: Math.ceil((cooldownMs - elapsed) / 1000) };
}

function setCooldown(userId, action) {
  if (!userCooldowns.has(userId)) userCooldowns.set(userId, new Map());
  userCooldowns.get(userId).set(action, Date.now());
}

// ─── Quotas (rolling window) ───────────────────────────────────

function _pruneQuota(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

/**
 * Check whether an action is currently within its quota. Does NOT
 * record a hit — call `recordQuota` after the action succeeds.
 * Returns `{ blocked, remainingSeconds, hits, max }`.
 *
 * `quotaKey` must be a key in LIMITS (e.g. 'WITHDRAW_PER_24H').
 */
function checkQuota(userId, quotaKey) {
  const limit = LIMITS[quotaKey];
  if (!limit || typeof limit.max !== 'number' || typeof limit.windowMs !== 'number') {
    return { blocked: false, remainingSeconds: 0, hits: 0, max: Infinity };
  }

  const userMap = userQuotas.get(userId);
  const arr = userMap ? userMap.get(quotaKey) || [] : [];
  _pruneQuota(arr, limit.windowMs);

  if (arr.length >= limit.max) {
    const oldestHit = arr[0];
    const resetAt = oldestHit + limit.windowMs;
    const remainingSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    return { blocked: true, remainingSeconds, hits: arr.length, max: limit.max };
  }
  return { blocked: false, remainingSeconds: 0, hits: arr.length, max: limit.max };
}

function recordQuota(userId, quotaKey) {
  if (!userQuotas.has(userId)) userQuotas.set(userId, new Map());
  const userMap = userQuotas.get(userId);
  if (!userMap.has(quotaKey)) userMap.set(quotaKey, []);
  userMap.get(quotaKey).push(Date.now());
}

// ─── Global on-chain cooldown ──────────────────────────────────

function checkOnchainCooldown(userId) {
  const cooldownMs = LIMITS.ONCHAIN_COOLDOWN_MS || 0;
  if (!cooldownMs) return { blocked: false, remainingSeconds: 0 };

  const last = userOnchainLast.get(userId);
  if (!last) return { blocked: false, remainingSeconds: 0 };

  const elapsed = Date.now() - last;
  if (elapsed >= cooldownMs) {
    userOnchainLast.delete(userId);
    return { blocked: false, remainingSeconds: 0 };
  }
  return { blocked: true, remainingSeconds: Math.ceil((cooldownMs - elapsed) / 1000) };
}

function recordOnchainAction(userId) {
  userOnchainLast.set(userId, Date.now());
}

// ─── Abuse tracking ────────────────────────────────────────────

/**
 * Record that a user was blocked by a rate limit. If they trip
 * enough times in the abuse window, ping the admin alerts channel.
 * `reason` is a short human-readable string for the alert memo.
 */
function trackBlock(userId, reason) {
  if (!userAbuseHits.has(userId)) userAbuseHits.set(userId, []);
  const arr = userAbuseHits.get(userId);
  _pruneQuota(arr, LIMITS.ABUSE_WINDOW_MS);
  arr.push(Date.now());

  if (arr.length >= LIMITS.ABUSE_THRESHOLD) {
    // De-bounce: only alert once per abuse window per user.
    const lastAlert = userAbuseAlerted.get(userId) || 0;
    if (Date.now() - lastAlert < LIMITS.ABUSE_WINDOW_MS) return;
    userAbuseAlerted.set(userId, Date.now());

    const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
    if (alertChannelId && discordClient) {
      try {
        const ch = discordClient.channels.cache.get(alertChannelId);
        if (ch && ch.send) {
          ch.send({
            content: `⚠️ **Rate-limit abuse signal**\n<@${userId}> hit ${arr.length} rate limits in the last ${Math.ceil(LIMITS.ABUSE_WINDOW_MS / 60000)} min.\nLatest reason: ${reason}\nConsider investigating or applying a temporary role restriction.`,
            allowedMentions: { users: [] },
          }).catch(() => {});
        }
      } catch { /* ignore */ }
    }
    console.warn(`[RateLimit] Abuse signal: user ${userId} — ${arr.length} blocks in ${LIMITS.ABUSE_WINDOW_MS / 60000} min. Reason: ${reason}`);
  }
}

// ─── Convenience: one-call guard for on-chain-triggering actions ──

/**
 * One-shot guard that checks the global on-chain cooldown AND a
 * rolling quota. Records the block to abuse tracker if either
 * check fails. Does NOT record the action — caller records on
 * success via `recordOnchainAction(userId)` + `recordQuota(userId, quotaKey)`.
 *
 * Returns { blocked, reason, message } — feed `message` to the user
 * as a reply when blocked.
 */
function guardOnchainAction(userId, quotaKey, actionLabel) {
  // 1. Global on-chain cooldown (60s between any two on-chain ops)
  const oc = checkOnchainCooldown(userId);
  if (oc.blocked) {
    trackBlock(userId, `${actionLabel} (on-chain cooldown, ${oc.remainingSeconds}s left)`);
    return {
      blocked: true,
      reason: 'onchain_cooldown',
      message: `⏳ Please wait ${oc.remainingSeconds}s before your next on-chain action.`,
    };
  }

  // 2. Per-action rolling quota
  const q = checkQuota(userId, quotaKey);
  if (q.blocked) {
    const mins = Math.ceil(q.remainingSeconds / 60);
    trackBlock(userId, `${actionLabel} (quota ${q.hits}/${q.max}, resets in ${mins}m)`);
    return {
      blocked: true,
      reason: 'quota',
      message: `🚫 You've hit the limit for **${actionLabel}** (${q.max} per window). Try again in ${mins} min.`,
    };
  }

  return { blocked: false };
}

module.exports = {
  setClient,
  checkCooldown,
  setCooldown,
  checkQuota,
  recordQuota,
  checkOnchainCooldown,
  recordOnchainAction,
  guardOnchainAction,
  trackBlock,
};
