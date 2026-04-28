import { ConflictError, UnauthorizedError } from "../shared/errors.js";
import { NICK_MAX_LEN, NICK_REGEX, isReserved } from "./profiles.constants.js";
import { generateToken, hashToken } from "./profiles.tokens.js";
import { serializeProfile } from "./profiles.dto.js";

const SUGGESTION_TARGET = 3;
const SUGGESTION_MAX_ATTEMPTS = 24;

function nowSec() {
	return Math.floor(Date.now() / 1000);
}

function randInt(min, max) {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function truncForSuffix(display, suffixLen) {
	const limit = Math.max(0, NICK_MAX_LEN - suffixLen);
	return display.slice(0, limit);
}

function buildCandidate(display, attempt) {
	if (attempt === 0) {
		return `${truncForSuffix(display, 2)}_2`;
	}
	if (attempt === 1) {
		const num = randInt(10, 99);
		return `${truncForSuffix(display, 3)}_${num}`;
	}
	if (attempt === 2) {
		return `${truncForSuffix(display, 1)}X`;
	}
	const num = randInt(100, 9999);
	return `${truncForSuffix(display, String(num).length + 1)}_${num}`;
}

function isCandidateValid(candidate) {
	if (!NICK_REGEX.test(candidate)) return false;
	if (isReserved(candidate.toLowerCase())) return false;
	return true;
}

export function createProfilesService({ repo }) {
	function suggestAlternatives(display) {
		const out = [];
		const seen = new Set();
		for (let i = 0; i < SUGGESTION_MAX_ATTEMPTS && out.length < SUGGESTION_TARGET; i++) {
			const candidate = buildCandidate(display, i);
			if (!isCandidateValid(candidate)) continue;
			const lower = candidate.toLowerCase();
			if (seen.has(lower)) continue;
			seen.add(lower);
			if (repo.getByLower(lower)) continue;
			out.push(candidate);
		}
		return out;
	}

	function check({ display, lower }) {
		const existing = repo.getByLower(lower);
		if (!existing) {
			return { available: true, suggestions: [] };
		}
		return { available: false, suggestions: suggestAlternatives(display) };
	}

	function register({ display, lower }) {
		if (repo.getByLower(lower)) {
			throw new ConflictError("nickname already taken", {
				suggestions: suggestAlternatives(display),
			});
		}
		const token = generateToken();
		const tokenHash = hashToken(token);
		const now = nowSec();
		repo.insert({
			nicknameLower: lower,
			nicknameDisplay: display,
			tokenHash,
			nowSec: now,
		});
		const profile = repo.getByLower(lower);
		return {
			nickname: profile.nickname_display,
			auth_token: token,
			profile: serializeProfile(profile),
		};
	}

	function authByToken(rawToken) {
		const hash = hashToken(rawToken);
		const row = repo.getByTokenHash(hash);
		if (!row) throw new UnauthorizedError("invalid auth_token");
		const now = nowSec();
		repo.updateLastSeen(row.nickname_lower, now);
		return {
			nickname: row.nickname_display,
			profile: serializeProfile({ ...row, last_seen_at: now }),
		};
	}

	function claim({ display, lower }) {
		const existing = repo.getByLower(lower);
		const now = nowSec();
		if (!existing) {
			return register({ display, lower });
		}
		const token = generateToken();
		const tokenHash = hashToken(token);
		repo.updateToken(lower, tokenHash, now);
		const fresh = repo.getByLower(lower);
		return {
			nickname: fresh.nickname_display,
			auth_token: token,
			profile: serializeProfile(fresh),
		};
	}

	return { check, register, authByToken, claim, suggestAlternatives };
}
