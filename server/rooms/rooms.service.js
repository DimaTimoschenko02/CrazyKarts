import { ConflictError, NotFoundError } from "../shared/errors.js";
import logger from "../shared/logger.js";
import { generateRoomCode } from "./rooms.code.js";
import { HEALTHCHECK_PORT_OFFSET, ROOM_STATES } from "./rooms.constants.js";

const SPAWN_READY_TIMEOUT_MS = 12000;

export function createRoomsService({ repo, portPool, processManager, internalToken }) {
	function nowSec() {
		return Math.floor(Date.now() / 1000);
	}

	async function create(input) {
		const port = portPool.allocate();
		if (port === null) {
			throw new ConflictError("server at capacity (no free ports)", {
				reason: "port_pool_exhausted",
			});
		}
		let code;
		try {
			code = generateRoomCode(repo.getActiveCodes());
		} catch (err) {
			portPool.release(port);
			throw err;
		}
		const healthcheckPort = port + HEALTHCHECK_PORT_OFFSET;
		const room = {
			code,
			name: input.name,
			hostName: input.hostName,
			mapId: input.mapId,
			maxPlayers: input.maxPlayers,
			currentPlayers: 0,
			durationMin: input.durationMin,
			port,
			healthcheckPort,
			state: ROOM_STATES.WAITING,
			createdAt: nowSec(),
			lastActivityAt: nowSec(),
			pid: null,
			child: null,
			missedHealthchecks: 0,
		};
		const spawned = processManager.spawnRoom({
			port,
			roomCode: code,
			mapName: input.mapId,
			maxPlayers: input.maxPlayers,
			durationMin: input.durationMin,
			healthcheckPort,
			internalToken,
		});
		room.pid = spawned.pid;
		room.child = spawned.child;
		repo.save(room);
		// Immediate crash detection: if the child exits before we cleanup, reap.
		if (room.child && typeof room.child.on === "function") {
			room.child.on("exit", (code, signal) => {
				if (room.state === ROOM_STATES.CLEANUP) return;
				cleanupRoom(room.code, `child_exit:${code ?? signal}`);
			});
		}
		// Wait for the Godot subprocess to bind its WS + healthcheck ports
		// before returning. Without this, the client receives ws_url and
		// connects before the backend is up → ECONNREFUSED on the proxy.
		if (typeof processManager.waitReady === "function") {
			const ready = await processManager.waitReady(healthcheckPort, SPAWN_READY_TIMEOUT_MS);
			if (!ready) {
				logger.warn(`[rooms] spawn timeout for ${code}, cleaning up`);
				cleanupRoom(code, "spawn_timeout");
				throw new ConflictError("room failed to start in time", { reason: "spawn_timeout" });
			}
		}
		return room;
	}

	function list() {
		return repo.listActive();
	}

	function getByCode(code) {
		const room = repo.getByCode(code);
		if (!room || room.state === ROOM_STATES.CLEANUP) {
			throw new NotFoundError("room not found", { code });
		}
		return room;
	}

	function cleanupRoom(code, reason) {
		const room = repo.getByCode(code);
		if (!room) return;
		room.state = ROOM_STATES.CLEANUP;
		if (room.child) {
			processManager.killProcess(room.child, "SIGTERM");
		}
		portPool.release(room.port);
		repo.delete(code);
		return { code, reason };
	}

	return { create, list, getByCode, cleanupRoom };
}
