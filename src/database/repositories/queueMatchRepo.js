// Queue match persistence — serializes the in-memory QueueMatch
// object (Maps + primitive arrays) to the `queue_matches` table and
// hydrates it back on bot startup.
//
// Read/write discipline:
//   save(match)     — upsert current state. Call after any phase
//                      transition or field mutation that we want
//                      to survive a restart.
//   markResolved(id) / markCancelled(id) — flip status to terminal
//                      state. Called from matchLifecycle.resolveMatch
//                      / cancelMatch just after the in-memory phase
//                      is set.
//   findActive()    — startup recovery: all non-resolved rows so
//                      src/queue/state.js can rehydrate activeMatches.
//   findMaxId()     — seed the in-memory _matchIdCounter so new
//                      matches don't collide with persisted ones.

const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM queue_matches WHERE id = ?'),
  findActive: db.prepare("SELECT * FROM queue_matches WHERE status = 'active' ORDER BY id ASC"),
  findMaxId: db.prepare('SELECT MAX(id) AS max_id FROM queue_matches'),

  upsert: db.prepare(`
    INSERT INTO queue_matches (
      id, phase, status,
      category_id, text_channel_id, voice_channel_id,
      players_json, team1_json, team2_json, captains_json,
      captain_votes_json, pick_order_json, current_picker, pick_index,
      team1_roles_json, team2_roles_json, team1_operators_json, team2_operators_json,
      maps_json, games_played, captain1_vote, captain2_vote, timer_deadline,
      updated_at
    ) VALUES (
      @id, @phase, @status,
      @categoryId, @textChannelId, @voiceChannelId,
      @playersJson, @team1Json, @team2Json, @captainsJson,
      @captainVotesJson, @pickOrderJson, @currentPicker, @pickIndex,
      @team1RolesJson, @team2RolesJson, @team1OperatorsJson, @team2OperatorsJson,
      @mapsJson, @gamesPlayed, @captain1Vote, @captain2Vote, @timerDeadline,
      datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      phase = excluded.phase,
      status = excluded.status,
      category_id = excluded.category_id,
      text_channel_id = excluded.text_channel_id,
      voice_channel_id = excluded.voice_channel_id,
      players_json = excluded.players_json,
      team1_json = excluded.team1_json,
      team2_json = excluded.team2_json,
      captains_json = excluded.captains_json,
      captain_votes_json = excluded.captain_votes_json,
      pick_order_json = excluded.pick_order_json,
      current_picker = excluded.current_picker,
      pick_index = excluded.pick_index,
      team1_roles_json = excluded.team1_roles_json,
      team2_roles_json = excluded.team2_roles_json,
      team1_operators_json = excluded.team1_operators_json,
      team2_operators_json = excluded.team2_operators_json,
      maps_json = excluded.maps_json,
      games_played = excluded.games_played,
      captain1_vote = excluded.captain1_vote,
      captain2_vote = excluded.captain2_vote,
      timer_deadline = excluded.timer_deadline,
      updated_at = datetime('now')
  `),

  markResolved: db.prepare(`
    UPDATE queue_matches
    SET status = 'resolved', phase = 'RESOLVED', resolved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
  markCancelled: db.prepare(`
    UPDATE queue_matches
    SET status = 'cancelled', phase = 'CANCELLED', resolved_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `),
};

function _mapToObj(m) {
  if (!m) return {};
  if (m instanceof Map) return Object.fromEntries(m);
  return m;
}

function _objToMap(o) {
  if (!o || typeof o !== 'object') return new Map();
  return new Map(Object.entries(o));
}

function _serialize(match) {
  return {
    id: match.id,
    phase: match.phase || 'WAITING_VOICE',
    status: (match.phase === 'RESOLVED' || match.phase === 'CANCELLED')
      ? (match.phase === 'RESOLVED' ? 'resolved' : 'cancelled')
      : 'active',
    categoryId: match.categoryId || null,
    textChannelId: match.textChannelId || null,
    voiceChannelId: match.voiceChannelId || null,
    playersJson: JSON.stringify(_mapToObj(match.players)),
    team1Json: JSON.stringify(match.team1 || []),
    team2Json: JSON.stringify(match.team2 || []),
    captainsJson: JSON.stringify(match.captains || { team1: null, team2: null }),
    captainVotesJson: JSON.stringify(_mapToObj(match.captainVotes)),
    pickOrderJson: JSON.stringify(match.pickOrder || []),
    currentPicker: match.currentPicker || null,
    pickIndex: match._pickIndex || 0,
    team1RolesJson: JSON.stringify(_mapToObj(match.team1Roles)),
    team2RolesJson: JSON.stringify(_mapToObj(match.team2Roles)),
    team1OperatorsJson: JSON.stringify(_mapToObj(match.team1Operators)),
    team2OperatorsJson: JSON.stringify(_mapToObj(match.team2Operators)),
    mapsJson: JSON.stringify(match.maps || []),
    gamesPlayed: match.gamesPlayed || 0,
    captain1Vote: match.captain1Vote == null ? null : match.captain1Vote,
    captain2Vote: match.captain2Vote == null ? null : match.captain2Vote,
    timerDeadline: match.timerDeadline || null,
  };
}

function _hydrate(row) {
  if (!row) return null;
  const safeParse = (s, fallback) => {
    try { return JSON.parse(s); } catch { return fallback; }
  };
  return {
    id: row.id,
    phase: row.phase,
    categoryId: row.category_id,
    textChannelId: row.text_channel_id,
    voiceChannelId: row.voice_channel_id,
    players: _objToMap(safeParse(row.players_json, {})),
    team1: safeParse(row.team1_json, []),
    team2: safeParse(row.team2_json, []),
    captains: safeParse(row.captains_json, { team1: null, team2: null }),
    captainVotes: _objToMap(safeParse(row.captain_votes_json, {})),
    pickOrder: safeParse(row.pick_order_json, []),
    currentPicker: row.current_picker,
    _pickIndex: row.pick_index || 0,
    team1Roles: _objToMap(safeParse(row.team1_roles_json, {})),
    team2Roles: _objToMap(safeParse(row.team2_roles_json, {})),
    team1Operators: _objToMap(safeParse(row.team1_operators_json, {})),
    team2Operators: _objToMap(safeParse(row.team2_operators_json, {})),
    maps: safeParse(row.maps_json, []),
    timer: null,
    timerDeadline: row.timer_deadline,
    gamesPlayed: row.games_played || 0,
    captain1Vote: row.captain1_vote,
    captain2Vote: row.captain2_vote,
    createdAt: new Date(row.created_at),
    // restored-from-DB flag so callers can distinguish fresh matches
    // from rehydrated ones (useful for recovery-specific handling).
    _fromDb: true,
  };
}

const queueMatchRepo = {
  /**
   * Persist the current state of a QueueMatch. Idempotent — call it
   * after any phase transition or field mutation. Failures are
   * logged but not thrown: losing a single write is a recovery
   * precision issue, not a correctness issue (next write catches up).
   */
  save(match) {
    if (!match || typeof match.id !== 'number') return;
    try {
      stmts.upsert.run(_serialize(match));
    } catch (err) {
      console.error(`[QueueMatchRepo] save failed for match #${match.id}:`, err.message);
    }
  },

  markResolved(matchId) {
    try {
      stmts.markResolved.run(matchId);
    } catch (err) {
      console.error(`[QueueMatchRepo] markResolved failed for #${matchId}:`, err.message);
    }
  },

  markCancelled(matchId) {
    try {
      stmts.markCancelled.run(matchId);
    } catch (err) {
      console.error(`[QueueMatchRepo] markCancelled failed for #${matchId}:`, err.message);
    }
  },

  findById(id) {
    const row = stmts.findById.get(id);
    return row ? _hydrate(row) : null;
  },

  /**
   * Load all active (non-terminal) queue matches for startup recovery.
   * Returns an array of hydrated QueueMatch objects with _fromDb=true.
   */
  findActive() {
    return stmts.findActive.all().map(_hydrate);
  },

  findMaxId() {
    const row = stmts.findMaxId.get();
    return row?.max_id || 0;
  },
};

module.exports = queueMatchRepo;
