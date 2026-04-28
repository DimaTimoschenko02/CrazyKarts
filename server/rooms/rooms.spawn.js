import { spawn } from "node:child_process";
import http from "node:http";
import config from "../config.js";
import logger from "../shared/logger.js";

export function createRealProcessManager() {
	function spawnRoom({ port, roomCode, mapName, maxPlayers, durationMin, healthcheckPort, internalToken }) {
		const args = [
			"--headless",
			"--path",
			config.godotProjectPath || ".",
			"--",
			"--port", String(port),
			"--room", roomCode,
			"--map", mapName,
			"--max-players", String(maxPlayers),
			"--duration-min", String(durationMin),
			"--healthcheck-port", String(healthcheckPort),
		];
		if (internalToken) {
			args.push("--internal-token", internalToken);
		}
		const child = spawn(config.godotBin, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line) logger.debug(`[godot:${roomCode}] ${line}`);
			}
		});
		child.stderr.on("data", (chunk) => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line) logger.warn(`[godot:${roomCode}:err] ${line}`);
			}
		});
		return { pid: child.pid, child };
	}

	function killProcess(child, signal = "SIGTERM") {
		try {
			child.kill(signal);
		} catch (err) {
			logger.warn("kill failed", { error: err?.message });
		}
	}

	async function waitReady(healthcheckPort, timeoutMs = 10000) {
		const start = Date.now();
		const deadline = start + timeoutMs;
		while (Date.now() < deadline) {
			const ok = await pingHealthcheck(healthcheckPort, 1000).catch(() => false);
			if (ok) return true;
			await sleep(250);
		}
		return false;
	}

	function pingHealthcheck(port, timeoutMs = 2000) {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{ hostname: "127.0.0.1", port, path: "/healthcheck", method: "GET", timeout: timeoutMs },
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (c) => (body += c));
					res.on("end", () => {
						if (res.statusCode === 200) {
							try {
								resolve(JSON.parse(body));
							} catch {
								resolve(true);
							}
						} else {
							reject(new Error(`status ${res.statusCode}`));
						}
					});
				},
			);
			req.on("error", reject);
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.end();
		});
	}

	return { spawnRoom, killProcess, waitReady, pingHealthcheck };
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// FakeProcessManager: used in tests and when SKIP_SPAWN=1 in dev (no Godot binary).
export function createFakeProcessManager({ spawnLog = [] } = {}) {
	let nextPid = 9000;
	const childrenByPid = new Map();
	return {
		spawnRoom(opts) {
			const pid = nextPid++;
			const child = {
				pid,
				killed: false,
				kill(signal) {
					this.killed = true;
					this._signal = signal;
				},
			};
			childrenByPid.set(pid, child);
			spawnLog.push({ pid, ...opts });
			return { pid, child };
		},
		killProcess(child, signal) {
			child.kill(signal);
		},
		async waitReady() {
			return true;
		},
		async pingHealthcheck() {
			return { state: "WAITING", players: 0 };
		},
		// test helpers
		_spawnLog: spawnLog,
		_children: childrenByPid,
	};
}
