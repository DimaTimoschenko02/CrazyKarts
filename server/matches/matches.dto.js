import { ValidationError } from "../shared/errors.js";

const PARTICIPANT_INT_FIELDS = [
	"kills", "deaths", "assists",
	"damage_dealt", "damage_taken",
	"shots_fired", "shots_hit",
	"score", "time_alive_sec", "best_killstreak",
];

export function validateMatchSubmit(raw) {
	if (!raw || typeof raw !== "object") {
		throw new ValidationError("body must be a JSON object");
	}
	const matchId = String(raw.match_id ?? "").trim();
	if (!/^[0-9a-f-]{36}$/i.test(matchId)) {
		throw new ValidationError("match_id must be a UUID v4");
	}
	const startedAt = Number.parseInt(raw.started_at, 10);
	const endedAt = Number.parseInt(raw.ended_at, 10);
	if (!Number.isInteger(startedAt) || !Number.isInteger(endedAt)) {
		throw new ValidationError("started_at / ended_at must be integers");
	}
	if (endedAt < startedAt) {
		throw new ValidationError("ended_at must be >= started_at");
	}
	const mapId = String(raw.map_id ?? "map_1");
	const roomCode = String(raw.room_code ?? "");
	const participantsIn = Array.isArray(raw.participants) ? raw.participants : null;
	if (!participantsIn) {
		throw new ValidationError("participants must be an array");
	}
	const participants = participantsIn.map((p, i) => normalizeParticipant(p, i));
	return { matchId, startedAt, endedAt, mapId, roomCode, participants };
}

function normalizeParticipant(p, index) {
	if (!p || typeof p !== "object") {
		throw new ValidationError(`participant[${index}] is not an object`);
	}
	const nickname = String(p.nickname ?? "").trim();
	if (nickname === "") {
		throw new ValidationError(`participant[${index}].nickname is required`);
	}
	const out = { nickname, nickname_lower: nickname.toLowerCase() };
	for (const field of PARTICIPANT_INT_FIELDS) {
		const v = Number.parseInt(p[field], 10);
		out[field] = Number.isFinite(v) && v >= 0 ? v : 0;
	}
	out.placement = Number.isInteger(p.placement) ? p.placement : null;
	out.weapon_stats = JSON.stringify(p.weapon_stats ?? []);
	return out;
}
