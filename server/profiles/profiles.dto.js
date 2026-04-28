import { ValidationError } from "../shared/errors.js";
import { NICK_REGEX, NICK_MAX_LEN, NICK_MIN_LEN, isReserved } from "./profiles.constants.js";

export function validateNickname(raw) {
	if (typeof raw !== "string") {
		throw new ValidationError("nickname must be a string");
	}
	const trimmed = raw.trim();
	if (trimmed.length < NICK_MIN_LEN || trimmed.length > NICK_MAX_LEN) {
		throw new ValidationError(
			`nickname must be ${NICK_MIN_LEN}-${NICK_MAX_LEN} chars`,
		);
	}
	if (!NICK_REGEX.test(trimmed)) {
		throw new ValidationError("nickname allows only letters, digits, _ and -");
	}
	const lower = trimmed.toLowerCase();
	if (isReserved(lower)) {
		throw new ValidationError("nickname is reserved", { reason: "reserved" });
	}
	return { display: trimmed, lower };
}

export function validateAuthToken(raw) {
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new ValidationError("auth_token is required");
	}
	return raw.trim();
}

export function serializeProfile(row) {
	if (!row) return null;
	return {
		nickname: row.nickname_display,
		nickname_lower: row.nickname_lower,
		created_at: row.created_at,
		last_seen_at: row.last_seen_at,
		stats: {
			total_kills: row.total_kills,
			total_deaths: row.total_deaths,
			total_assists: row.total_assists,
			total_damage_dealt: row.total_damage_dealt,
			total_damage_taken: row.total_damage_taken,
			total_shots_fired: row.total_shots_fired,
			total_shots_hit: row.total_shots_hit,
			total_matches: row.total_matches,
			total_wins: row.total_wins,
		},
	};
}
