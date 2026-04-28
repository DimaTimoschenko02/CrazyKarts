import logger from "../shared/logger.js";

export function createMatchesService({ db, repo }) {
	function nowSec() {
		return Math.floor(Date.now() / 1000);
	}

	function submit(payload) {
		const { matchId, startedAt, endedAt, mapId, roomCode, participants } = payload;
		const durationS = Math.max(0, endedAt - startedAt);

		const winnerLower = pickWinner(participants);

		const tx = db.transaction(() => {
			repo.insertMatch({
				matchId,
				startedAt,
				endedAt,
				mapId,
				roomCode,
				playerCount: participants.length,
				durationS,
			});
			let inserted = 0;
			let skipped = 0;
			const now = nowSec();
			for (const p of participants) {
				if (!repo.profileExists(p.nickname_lower)) {
					skipped++;
					continue;
				}
				repo.insertParticipant(matchId, p);
				const wonFlag = p.nickname_lower === winnerLower ? 1 : 0;
				repo.bumpProfile(p, wonFlag, now);
				inserted++;
			}
			return { inserted, skipped };
		});

		const result = tx();
		logger.info("match submitted", {
			match_id: matchId,
			room_code: roomCode,
			players: participants.length,
			inserted: result.inserted,
			skipped: result.skipped,
			duration_s: durationS,
		});
		return result;
	}

	function pickWinner(participants) {
		let best = null;
		for (const p of participants) {
			if (best === null) {
				best = p;
				continue;
			}
			if (p.score > best.score) best = p;
		}
		return best ? best.nickname_lower : null;
	}

	return { submit };
}
