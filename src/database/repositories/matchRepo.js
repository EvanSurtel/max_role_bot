const db = require('../db');

const stmts = {
  findById: db.prepare('SELECT * FROM matches WHERE id = ?'),
  findByChallengeId: db.prepare('SELECT * FROM matches WHERE challenge_id = ?'),
  create: db.prepare(`
    INSERT INTO matches (challenge_id, category_id)
    VALUES (@challengeId, @categoryId)
    RETURNING *
  `),
  setChannels: db.prepare(`
    UPDATE matches
    SET team1_voice_id = @team1VoiceId,
        team1_text_id = @team1TextId,
        team2_voice_id = @team2VoiceId,
        team2_text_id = @team2TextId,
        shared_voice_id = @sharedVoiceId,
        shared_text_id = @sharedTextId,
        voting_channel_id = @votingChannelId
    WHERE id = @id
  `),
  setCaptain1Vote: db.prepare(`
    UPDATE matches
    SET captain1_vote = ?,
        first_vote_at = COALESCE(first_vote_at, datetime('now'))
    WHERE id = ?
  `),
  setCaptain2Vote: db.prepare(`
    UPDATE matches
    SET captain2_vote = ?,
        first_vote_at = COALESCE(first_vote_at, datetime('now'))
    WHERE id = ?
  `),
  setWinner: db.prepare(`
    UPDATE matches SET winning_team = ?, resolved_at = datetime('now') WHERE id = ?
  `),
  updateStatus: db.prepare('UPDATE matches SET status = ? WHERE id = ?'),
};

const matchRepo = {
  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByChallengeId(challengeId) {
    return stmts.findByChallengeId.get(challengeId) || null;
  },

  create({ challengeId, categoryId }) {
    return stmts.create.get({ challengeId, categoryId: categoryId || null });
  },

  setChannels(id, { team1VoiceId, team1TextId, team2VoiceId, team2TextId, sharedVoiceId, sharedTextId, votingChannelId }) {
    return stmts.setChannels.run({
      id,
      team1VoiceId: team1VoiceId || null,
      team1TextId: team1TextId || null,
      team2VoiceId: team2VoiceId || null,
      team2TextId: team2TextId || null,
      sharedVoiceId: sharedVoiceId || null,
      sharedTextId: sharedTextId || null,
      votingChannelId: votingChannelId || null,
    });
  },

  setCaptainVote(id, captainNumber, vote) {
    if (captainNumber === 1) {
      return stmts.setCaptain1Vote.run(vote, id);
    } else if (captainNumber === 2) {
      return stmts.setCaptain2Vote.run(vote, id);
    }
    throw new Error(`Invalid captain number: ${captainNumber}. Must be 1 or 2.`);
  },

  setWinner(id, winningTeam) {
    return stmts.setWinner.run(winningTeam, id);
  },

  updateStatus(id, status) {
    return stmts.updateStatus.run(status, id);
  },
};

module.exports = matchRepo;
