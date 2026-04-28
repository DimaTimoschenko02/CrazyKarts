import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

import { createProfilesRepository } from "./profiles.repository.js";
import { createProfilesService } from "./profiles.service.js";
import { validateNickname } from "./profiles.dto.js";
import { hashToken } from "./profiles.tokens.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "../db/schema.sql");

function makeFreshService() {
	const db = new Database(":memory:");
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	const repo = createProfilesRepository(db);
	const service = createProfilesService({ repo });
	return { db, repo, service };
}

test("validateNickname: rejects too-short, charset, reserved", () => {
	assert.throws(() => validateNickname("a"), /chars/);
	assert.throws(() => validateNickname("with space"), /letters/);
	assert.throws(() => validateNickname("admin"), /reserved/);
	const ok = validateNickname("Dima");
	assert.equal(ok.display, "Dima");
	assert.equal(ok.lower, "dima");
});

test("register: creates profile and returns token + serialized profile", () => {
	const { service } = makeFreshService();
	const result = service.register(validateNickname("Dima"));
	assert.equal(result.nickname, "Dima");
	assert.match(result.auth_token, /^[0-9a-f-]{36}$/);
	assert.equal(result.profile.nickname, "Dima");
	assert.equal(result.profile.stats.total_kills, 0);
});

test("register: case-insensitive duplicate throws ConflictError with suggestions", () => {
	const { service } = makeFreshService();
	service.register(validateNickname("Dima"));
	let captured;
	try {
		service.register(validateNickname("dima"));
	} catch (err) {
		captured = err;
	}
	assert.ok(captured, "expected throw");
	assert.equal(captured.status, 409);
	assert.equal(captured.code, "conflict");
	assert.ok(Array.isArray(captured.details.suggestions));
	assert.ok(captured.details.suggestions.length > 0);
	for (const s of captured.details.suggestions) {
		assert.notEqual(s.toLowerCase(), "dima");
	}
});

test("check: available true when free, false with suggestions when taken", () => {
	const { service } = makeFreshService();
	const free = service.check(validateNickname("Newbie"));
	assert.equal(free.available, true);
	assert.deepEqual(free.suggestions, []);

	service.register(validateNickname("Dima"));
	const taken = service.check(validateNickname("DIMA"));
	assert.equal(taken.available, false);
	assert.ok(taken.suggestions.length > 0);
});

test("authByToken: returns profile for valid token, throws 401 for unknown", () => {
	const { service } = makeFreshService();
	const reg = service.register(validateNickname("Dima"));

	const ok = service.authByToken(reg.auth_token);
	assert.equal(ok.nickname, "Dima");
	assert.equal(ok.profile.stats.total_matches, 0);

	let captured;
	try {
		service.authByToken("not-a-real-token");
	} catch (err) {
		captured = err;
	}
	assert.equal(captured.status, 401);
});

test("authByToken: hash collision-safe (different token → 401, same → ok)", () => {
	const { service, db } = makeFreshService();
	const reg = service.register(validateNickname("Dima"));
	const stored = db.prepare("SELECT auth_token_hash FROM profiles WHERE nickname_lower=?").get("dima");
	assert.equal(stored.auth_token_hash, hashToken(reg.auth_token));
});

test("claim: re-issues token for existing profile, registers if new", () => {
	const { service } = makeFreshService();
	const created = service.register(validateNickname("Dima"));

	const reissued = service.claim(validateNickname("Dima"));
	assert.equal(reissued.nickname, "Dima");
	assert.notEqual(reissued.auth_token, created.auth_token);

	let captured;
	try {
		service.authByToken(created.auth_token);
	} catch (err) {
		captured = err;
	}
	assert.equal(captured.status, 401, "old token must be invalidated");

	const ok = service.authByToken(reissued.auth_token);
	assert.equal(ok.nickname, "Dima");

	const fresh = service.claim(validateNickname("NewGuy"));
	assert.match(fresh.auth_token, /^[0-9a-f-]{36}$/);
	assert.equal(fresh.profile.nickname, "NewGuy");
});

test("suggestions: respect max 20 chars and avoid reserved", () => {
	const { service } = makeFreshService();
	service.register(validateNickname("xxxxxxxxxxxxxxxxxxxx")); // 20 chars
	const taken = service.check(validateNickname("xxxxxxxxxxxxxxxxxxxx"));
	for (const s of taken.suggestions) {
		assert.ok(s.length <= 20, `suggestion "${s}" exceeds 20 chars`);
		assert.match(s, /^[A-Za-z0-9_-]+$/);
	}
});
