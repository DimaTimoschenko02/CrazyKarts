import { createHash, timingSafeEqual } from "node:crypto";
import { v4 as uuidv4 } from "uuid";

export function generateToken() {
	return uuidv4();
}

export function hashToken(plain) {
	return createHash("sha256").update(plain, "utf8").digest("hex");
}

export function verifyToken(plain, knownHash) {
	const candidate = Buffer.from(hashToken(plain), "hex");
	const expected = Buffer.from(knownHash, "hex");
	if (candidate.length !== expected.length) return false;
	return timingSafeEqual(candidate, expected);
}
