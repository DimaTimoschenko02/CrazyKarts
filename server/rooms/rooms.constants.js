// Room codes use a charset that avoids confusable glyphs (no 0/O/I/1).
export const ROOM_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LEN = 6;

export const ROOM_NAME_REGEX = /^[\p{L}\p{N} _\-!?.,()'`]{1,32}$/u;
export const ROOM_NAME_MAX = 32;

export const MAX_PLAYERS_MIN = 2;
export const MAX_PLAYERS_MAX = 8;

export const DURATION_MIN_OPTIONS = Object.freeze([5, 10, 20]);

export const ROOM_STATES = Object.freeze({
	WAITING: "WAITING",
	IN_MATCH: "IN_MATCH",
	POST_MATCH: "POST_MATCH",
	CLEANUP: "CLEANUP",
});

export const HEALTHCHECK_PORT_OFFSET = 1000;

export const DEFAULT_MAP_ID = "map_1";
