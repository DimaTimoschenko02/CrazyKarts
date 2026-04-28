/**
 * Sequential SQLite migrations tracked via PRAGMA user_version.
 *
 * Each entry is { version: N, name: string, sql: string }. They are applied
 * in order; only those with version > current user_version run. Add new
 * migrations to the end of the array. Never edit a published migration.
 *
 * The base schema lives in db/schema.sql (idempotent CREATE TABLE IF NOT EXISTS)
 * and is applied at version 1. Subsequent ALTERs go here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchemaSql() {
	return readFileSync(resolve(__dirname, "schema.sql"), "utf8");
}

export const migrations = [
	{
		version: 1,
		name: "initial_schema",
		sql: loadSchemaSql(),
	},
	// Future migrations go here, e.g.:
	// { version: 2, name: "add_damage_events", sql: "CREATE TABLE damage_events (...)" },
];

export function applyMigrations(db, logger) {
	const current = db.pragma("user_version", { simple: true });
	const pending = migrations.filter((m) => m.version > current);
	if (pending.length === 0) {
		logger?.debug?.("DB: no migrations pending", { current });
		return { applied: 0, version: current };
	}
	for (const m of pending) {
		logger?.info?.(`DB: applying migration v${m.version} (${m.name})`);
		db.exec("BEGIN");
		try {
			db.exec(m.sql);
			db.pragma(`user_version = ${m.version}`);
			db.exec("COMMIT");
		} catch (err) {
			db.exec("ROLLBACK");
			throw new Error(`Migration v${m.version} (${m.name}) failed: ${err.message}`);
		}
	}
	const finalVersion = pending[pending.length - 1].version;
	return { applied: pending.length, version: finalVersion };
}
