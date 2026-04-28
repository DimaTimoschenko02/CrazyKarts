import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import config from "../config.js";
import logger from "../shared/logger.js";
import { applyMigrations } from "./migrations.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const result = applyMigrations(db, logger);
logger.info("DB ready", {
	path: config.dbPath,
	version: result.version,
	migrations_applied: result.applied,
});

export { db };
export default db;
