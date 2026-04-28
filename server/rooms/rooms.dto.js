import { ValidationError } from "../shared/errors.js";
import {
	DURATION_MIN_OPTIONS,
	MAX_PLAYERS_MAX,
	MAX_PLAYERS_MIN,
	ROOM_NAME_MAX,
	ROOM_NAME_REGEX,
	DEFAULT_MAP_ID,
} from "./rooms.constants.js";

export function validateCreateRoomBody(raw) {
	if (!raw || typeof raw !== "object") {
		throw new ValidationError("body must be a JSON object");
	}
	const hostName = String(raw.host_name ?? "").trim();
	if (hostName === "") {
		throw new ValidationError("host_name is required");
	}
	if (hostName.length > 20) {
		throw new ValidationError("host_name too long");
	}
	const name = String(raw.name ?? hostName + "'s room").slice(0, ROOM_NAME_MAX).trim();
	if (!ROOM_NAME_REGEX.test(name)) {
		throw new ValidationError("invalid room name");
	}
	const maxPlayers = Number.parseInt(raw.max_players, 10);
	if (
		!Number.isInteger(maxPlayers) ||
		maxPlayers < MAX_PLAYERS_MIN ||
		maxPlayers > MAX_PLAYERS_MAX
	) {
		throw new ValidationError(
			`max_players must be ${MAX_PLAYERS_MIN}-${MAX_PLAYERS_MAX}`,
		);
	}
	const durationMin = Number.parseInt(raw.duration_min, 10);
	if (!DURATION_MIN_OPTIONS.includes(durationMin)) {
		throw new ValidationError(
			`duration_min must be one of ${DURATION_MIN_OPTIONS.join(",")}`,
		);
	}
	const mapId = String(raw.map_id ?? DEFAULT_MAP_ID);
	return { hostName, name, maxPlayers, durationMin, mapId };
}

export function serializeRoom(room, { wsBaseUrl, inviteBaseUrl } = {}) {
	if (!room) return null;
	const wsUrl = wsBaseUrl ? `${wsBaseUrl.replace(/\/$/, "")}/ws/${room.code}` : null;
	const inviteLink = inviteBaseUrl
		? `${inviteBaseUrl.replace(/\/$/, "")}/?join=${room.code}`
		: null;
	return {
		room_code: room.code,
		room_id: room.code, // alias for clients that use either name
		name: room.name,
		host_name: room.hostName,
		map_id: room.mapId,
		max_players: room.maxPlayers,
		current_players: room.currentPlayers,
		duration_min: room.durationMin,
		state: room.state,
		is_full: room.currentPlayers >= room.maxPlayers,
		created_at: room.createdAt,
		ws_url: wsUrl,
		invite_link: inviteLink,
	};
}
