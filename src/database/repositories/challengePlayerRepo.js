const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM challenge_players WHERE id = ?'),
  findByChallengeId: db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ?'),
  findByUserId: db.prepare('SELECT * FROM challenge_players WHERE user_id = ?'),
  findByChallengeAndUser: db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ? AND user_id = ?'),
  findByChallengeAndTeam: db.prepare('SELECT * FROM challenge_players WHERE challenge_id = ? AND team = ?'),
  create: db.prepare(`
    INSERT INTO challenge_players (challenge_id, user_id, team, role, status, funds_held, notification_channel_id)
    VALUES (@challengeId, @userId, @team, @role, @status, @fundsHeld, @notificationChannelId)
    RETURNING *
  `),
  updateStatus: db.prepare('UPDATE challenge_players SET status = ? WHERE id = ?'),
  setFundsHeld: db.prepare('UPDATE challenge_players SET funds_held = ? WHERE id = ?'),
  setNotificationChannel: db.prepare('UPDATE challenge_players SET notification_channel_id = ? WHERE id = ?'),
  countAcceptedByTeam: db.prepare(
    "SELECT COUNT(*) as count FROM challenge_players WHERE challenge_id = ? AND team = ? AND status = 'accepted'"
  ),
  countPendingByChallenge: db.prepare(
    "SELECT COUNT(*) as count FROM challenge_players WHERE challenge_id = ? AND status = 'pending'"
  ),
};

const challengePlayerRepo = {
  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByChallengeId(challengeId) {
    return stmts.findByChallengeId.all(challengeId);
  },

  findByUserId(userId) {
    return stmts.findByUserId.all(userId);
  },

  findByChallengeAndUser(challengeId, userId) {
    return stmts.findByChallengeAndUser.get(challengeId, userId) || null;
  },

  findByChallengeAndTeam(challengeId, team) {
    return stmts.findByChallengeAndTeam.all(challengeId, team);
  },

  create({ challengeId, userId, team, role = 'player', status = 'pending', fundsHeld = 0, notificationChannelId = null }) {
    return stmts.create.get({
      challengeId,
      userId,
      team,
      role,
      status,
      fundsHeld,
      notificationChannelId,
    });
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },

  setFundsHeld(id, held) {
    return stmts.setFundsHeld.run(held ? 1 : 0, id);
  },

  setNotificationChannel(id, channelId) {
    return stmts.setNotificationChannel.run(channelId, id);
  },

  countAcceptedByTeam(challengeId, team) {
    return stmts.countAcceptedByTeam.get(challengeId, team).count;
  },

  countPendingByChallenge(challengeId) {
    return stmts.countPendingByChallenge.get(challengeId).count;
  },
};

module.exports = challengePlayerRepo;
