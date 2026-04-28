import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { createProfilesRepository } from "../profiles/profiles.repository.js";
import { createProfilesService } from "../profiles/profiles.service.js";
import { validateNickname } from "../profiles/profiles.dto.js";
import { createMatchesRepository } from "./matches.repository.js";
import { createMatchesService } from "./matches.service.js";
import { validateMatchSubmit } from "./matches.dto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(__dirname, "../db/schema.sql"), "utf8");

function makeWiring() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(SCHEMA);
	const profilesRepo = createProfilesRepository(db);
	const profilesService = createProfilesService({ repo: profilesRepo });
	const matchesRepo = createMatchesRepository(db);
	const matchesService = createMatchesService({ db, repo: matchesRepo });
	return { db, profilesService, matchesService };
}

const SAMPLE_MATCH = (overrides = {}) => ({
	match_id: randomUUID(),
	started_at: 1_000_000,
	ended_at:   1_000_300,
	map_id: "map_1",
	room_code: "AAAAAA",
	participants: [
		{ nickname: "Dima",  kills: 5, deaths: 2, assists: 1, damage_dealt: 250, damage_taken: 80,  shots_fired: 30, shots_hit: 15, score: 510 },
		{ nickname: "Misha", kills: 3, deaths: 4, assists: 0, damage_dealt: 180, damage_taken: 220, shots_fired: 25, shots_hit: 10, score: 300 },
	],
	...overrides,
});

test("validateMatchSubmit rejects bad UUID + missing fields", () => {
	assert.throws(() => validateMatchSubmit({}), /match_id/);
	assert.throws(() => validateMatchSubmit({ match_id: "not-uuid" }), /UUID/);
	const ok = validateMatchSubmit(SAMPLE_MATCH());
	assert.equal(ok.participants.length, 2);
	assert.equal(ok.participants[0].nickname_lower, "dima");
});

test("submit: writes match, participants, bumps profile aggregates", () => {
	const { db, profilesService, matchesService } = makeWiring();
	profilesService.register(validateNickname("Dima"));
	profilesService.register(validateNickname("Misha"));

	const payload = validateMatchSubmit(SAMPLE_MATCH());
	const r = matchesService.submit(payload);
	assert.equal(r.inserted, 2);
	assert.equal(r.skipped, 0);

	const dimaRow = db.prepare("SELECT * FROM profiles WHERE nickname_lower=?").get("dima");
	assert.equal(dimaRow.total_kills, 5);
	assert.equal(dimaRow.total_deaths, 2);
	assert.equal(dimaRow.total_matches, 1);
	assert.equal(dimaRow.total_wins, 1, "Dima had higher score → won");

	const mishaRow = db.prepare("SELECT * FROM profiles WHERE nickname_lower=?").get("misha");
	assert.equal(mishaRow.total_kills, 3);
	assert.equal(mishaRow.total_wins, 0);

	const matchRow = db.prepare("SELECT * FROM matches WHERE match_id=?").get(payload.matchId);
	assert.equal(matchRow.player_count, 2);
	assert.equal(matchRow.duration_s, 300);

	const partRows = db.prepare("SELECT * FROM match_participants WHERE match_id=?").all(payload.matchId);
	assert.equal(partRows.length, 2);
});

test("submit skips unknown nickname; aggregates only for registered profiles", () => {
	const { db, profilesService, matchesService } = makeWiring();
	profilesService.register(validateNickname("Dima"));
	const payload = validateMatchSubmit(SAMPLE_MATCH({
		participants: [
			{ nickname: "Dima", kills: 4, deaths: 0, score: 400, damage_dealt: 100, damage_taken: 0, shots_fired: 10, shots_hit: 8, assists: 0 },
			{ nickname: "GhostPlayer", kills: 1, deaths: 1, score: 100, damage_dealt: 20, damage_taken: 50, shots_fired: 5, shots_hit: 2, assists: 0 },
		],
	}));
	const r = matchesService.submit(payload);
	assert.equal(r.inserted, 1);
	assert.equal(r.skipped, 1);

	const dima = db.prepare("SELECT * FROM profiles WHERE nickname_lower=?").get("dima");
	assert.equal(dima.total_kills, 4);
	assert.equal(dima.total_matches, 1);
});

test("submit transaction is atomic: failure rolls everything back", () => {
	const { db, profilesService, matchesService } = makeWiring();
	profilesService.register(validateNickname("Dima"));

	const matchId = randomUUID();
	const payload = validateMatchSubmit(SAMPLE_MATCH({ match_id: matchId, participants: [
		{ nickname: "Dima", kills: 1, deaths: 0, score: 100, damage_dealt: 50, damage_taken: 0, shots_fired: 1, shots_hit: 1, assists: 0 },
	]}));
	matchesService.submit(payload);

	let captured;
	try {
		matchesService.submit(payload); // duplicate match_id PK
	} catch (err) {
		captured = err;
	}
	assert.ok(captured, "expected duplicate insert to throw");

	const dima = db.prepare("SELECT total_kills, total_matches FROM profiles WHERE nickname_lower=?").get("dima");
	assert.equal(dima.total_kills, 1, "no double-bump");
	assert.equal(dima.total_matches, 1);
});
