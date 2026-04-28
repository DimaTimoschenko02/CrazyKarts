export function createMatchesRepository(db) {
	const stmts = {
		insertMatch: db.prepare(`
			INSERT INTO matches (match_id, started_at, ended_at, map_id, room_code, player_count, duration_s)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`),
		insertParticipant: db.prepare(`
			INSERT INTO match_participants (
				match_id, nickname_lower, kills, deaths, assists,
				damage_dealt, damage_taken, shots_fired, shots_hit,
				score, placement, weapon_stats
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		profileExists: db.prepare("SELECT 1 FROM profiles WHERE nickname_lower = ?"),
		bumpProfile: db.prepare(`
			UPDATE profiles SET
				total_kills        = total_kills        + ?,
				total_deaths       = total_deaths       + ?,
				total_assists      = total_assists      + ?,
				total_damage_dealt = total_damage_dealt + ?,
				total_damage_taken = total_damage_taken + ?,
				total_shots_fired  = total_shots_fired  + ?,
				total_shots_hit    = total_shots_hit    + ?,
				total_matches      = total_matches      + 1,
				total_wins         = total_wins         + ?,
				last_seen_at       = ?
			WHERE nickname_lower = ?
		`),
	};

	return {
		insertMatch(row) {
			stmts.insertMatch.run(
				row.matchId, row.startedAt, row.endedAt, row.mapId, row.roomCode,
				row.playerCount, row.durationS,
			);
		},
		insertParticipant(matchId, p) {
			stmts.insertParticipant.run(
				matchId, p.nickname_lower,
				p.kills, p.deaths, p.assists,
				p.damage_dealt, p.damage_taken,
				p.shots_fired, p.shots_hit,
				p.score, p.placement, p.weapon_stats,
			);
		},
		profileExists(nicknameLower) {
			return !!stmts.profileExists.get(nicknameLower);
		},
		bumpProfile(p, wonFlag, nowSec) {
			stmts.bumpProfile.run(
				p.kills, p.deaths, p.assists,
				p.damage_dealt, p.damage_taken,
				p.shots_fired, p.shots_hit,
				wonFlag, nowSec, p.nickname_lower,
			);
		},
	};
}
