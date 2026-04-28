import { randomInt } from "node:crypto";
import { ROOM_CODE_CHARSET, ROOM_CODE_LEN } from "./rooms.constants.js";

export function generateRoomCode(usedCodes = new Set(), maxAttempts = 32) {
	for (let i = 0; i < maxAttempts; i++) {
		let out = "";
		for (let j = 0; j < ROOM_CODE_LEN; j++) {
			out += ROOM_CODE_CHARSET[randomInt(0, ROOM_CODE_CHARSET.length)];
		}
		if (!usedCodes.has(out)) return out;
	}
	throw new Error("Failed to generate unique room code");
}
