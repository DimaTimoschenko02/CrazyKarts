export function createProfilesRepository(db) {
	const stmts = {
		getByLower: db.prepare("SELECT * FROM profiles WHERE nickname_lower = ?"),
		getByTokenHash: db.prepare("SELECT * FROM profiles WHERE auth_token_hash = ?"),
		insert: db.prepare(`
			INSERT INTO profiles (nickname_lower, nickname_display, auth_token_hash, created_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?)
		`),
		updateLastSeen: db.prepare("UPDATE profiles SET last_seen_at = ? WHERE nickname_lower = ?"),
		updateToken: db.prepare(`
			UPDATE profiles SET auth_token_hash = ?, last_seen_at = ? WHERE nickname_lower = ?
		`),
	};

	return {
		getByLower(nicknameLower) {
			return stmts.getByLower.get(nicknameLower) || null;
		},
		getByTokenHash(hash) {
			return stmts.getByTokenHash.get(hash) || null;
		},
		insert({ nicknameLower, nicknameDisplay, tokenHash, nowSec }) {
			stmts.insert.run(nicknameLower, nicknameDisplay, tokenHash, nowSec, nowSec);
		},
		updateLastSeen(nicknameLower, nowSec) {
			stmts.updateLastSeen.run(nowSec, nicknameLower);
		},
		updateToken(nicknameLower, tokenHash, nowSec) {
			stmts.updateToken.run(tokenHash, nowSec, nicknameLower);
		},
	};
}
