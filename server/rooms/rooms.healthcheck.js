import config from "../config.js";
import logger from "../shared/logger.js";

const MAX_MISSED = 3; // 3 × interval ≈ 15 s by default

export function startHealthcheckLoop({ repo, service, processManager }) {
	const intervalMs = Math.max(1, config.healthcheckIntervalS) * 1000;
	const idleMs = Math.max(1, config.idleTimeoutS) * 1000;

	const handle = setInterval(() => {
		const rooms = repo.listActive();
		const now = Date.now();
		for (const room of rooms) {
			pollOne(room, processManager).then((result) => {
				if (result.ok) {
					room.missedHealthchecks = 0;
					room.currentPlayers = Number(result.body?.players ?? room.currentPlayers ?? 0);
					if (typeof result.body?.state === "string") {
						room.state = result.body.state;
					}
					if (room.currentPlayers > 0) {
						room.lastActivityAt = Math.floor(now / 1000);
					}
				} else {
					room.missedHealthchecks = (room.missedHealthchecks ?? 0) + 1;
					if (room.missedHealthchecks >= MAX_MISSED) {
						logger.warn(`[healthcheck] reaping room ${room.code} after ${MAX_MISSED} misses`);
						service.cleanupRoom(room.code, "healthcheck_timeout");
						return;
					}
				}
				if (
					room.currentPlayers === 0 &&
					(now - room.lastActivityAt * 1000) > idleMs
				) {
					logger.info(`[healthcheck] idle cleanup ${room.code}`);
					service.cleanupRoom(room.code, "idle_timeout");
				}
			}).catch((err) => {
				logger.error(`[healthcheck] poller error ${room.code}: ${err?.message}`);
			});
		}
	}, intervalMs);
	handle.unref();
	return { stop() { clearInterval(handle); } };
}

async function pollOne(room, processManager) {
	try {
		const body = await processManager.pingHealthcheck(room.healthcheckPort, 2000);
		return { ok: true, body };
	} catch (err) {
		return { ok: false, error: err?.message };
	}
}
