export const NICK_MIN_LEN = 2;
export const NICK_MAX_LEN = 20;

export const NICK_REGEX = /^[A-Za-z0-9_-]{2,20}$/;

export const RESERVED_NICKS = Object.freeze([
	"server",
	"admin",
	"bot",
	"ai",
	"system",
	"moderator",
	"host",
	"god",
	"null",
	"undefined",
	"root",
	"anonymous",
]);

export function isReserved(nicknameLower) {
	return RESERVED_NICKS.includes(nicknameLower);
}
