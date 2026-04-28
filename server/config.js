import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function required(name) {
	const value = process.env[name];
	if (!value || value.trim() === "") {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function intEnv(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
	}
	return parsed;
}

function listEnv(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function resolvePath(p) {
	if (!p) return p;
	return resolve(__dirname, p);
}

export const config = Object.freeze({
	masterHost: process.env.MASTER_HOST || "127.0.0.1",
	masterPort: intEnv("MASTER_PORT", 8080),

	dbPath: resolvePath(process.env.DB_PATH || "./data/smashkarts.db"),

	corsOrigins: listEnv("CORS_ORIGINS", [
		"http://localhost:8060",
		"http://127.0.0.1:8060",
	]),

	internalToken: required("INTERNAL_TOKEN"),

	godotBin: required("GODOT_BIN"),

	portPoolStart: intEnv("PORT_POOL_START", 4445),
	portPoolSize: intEnv("PORT_POOL_SIZE", 100),

	healthcheckIntervalS: intEnv("HEALTHCHECK_INTERVAL_S", 5),
	healthcheckTimeoutS: intEnv("HEALTHCHECK_TIMEOUT_S", 15),

	idleTimeoutS: intEnv("IDLE_TIMEOUT_S", 300),

	publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8080",
	publicWsBaseUrl: process.env.PUBLIC_WS_BASE_URL || "",
	publicClientUrl: process.env.PUBLIC_CLIENT_URL || "http://127.0.0.1:8060",
	godotProjectPath: process.env.GODOT_PROJECT_PATH || "",

	devMode: process.env.DEV_MODE === "1",
});

export default config;
