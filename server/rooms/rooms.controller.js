import { Router } from "express";
import config from "../config.js";
import { createRoomsRepository } from "./rooms.repository.js";
import { createRoomsService } from "./rooms.service.js";
import { createPortPool } from "./rooms.port_pool.js";
import { createRealProcessManager, createFakeProcessManager } from "./rooms.spawn.js";
import { validateCreateRoomBody, serializeRoom } from "./rooms.dto.js";
import { startHealthcheckLoop } from "./rooms.healthcheck.js";

function makeWsBaseUrl() {
	if (config.publicWsBaseUrl) return config.publicWsBaseUrl;
	return config.publicBaseUrl.replace(/^http/, "ws");
}

function makeInviteBaseUrl() {
	return config.publicClientUrl || "";
}

const repo = createRoomsRepository();
const portPool = createPortPool({ start: config.portPoolStart, size: config.portPoolSize });
const useFakeSpawn = config.devMode && process.env.SKIP_SPAWN === "1";
const processManager = useFakeSpawn ? createFakeProcessManager() : createRealProcessManager();
const service = createRoomsService({
	repo,
	portPool,
	processManager,
	internalToken: config.internalToken,
});

const wsBaseUrl = makeWsBaseUrl();
const inviteBaseUrl = makeInviteBaseUrl();

export function createRoomsRouter(svc = service) {
	const router = Router();

	router.get("/api/rooms", (_req, res) => {
		const rooms = svc.list().map((r) => serializeRoom(r, { wsBaseUrl, inviteBaseUrl }));
		res.json({ rooms });
	});

	router.post("/api/rooms", async (req, res, next) => {
		try {
			const input = validateCreateRoomBody(req.body);
			const room = await svc.create(input);
			res.status(201).json(serializeRoom(room, { wsBaseUrl, inviteBaseUrl }));
		} catch (err) {
			next(err);
		}
	});

	router.get("/api/rooms/:code", (req, res) => {
		const room = svc.getByCode(req.params.code);
		res.json(serializeRoom(room, { wsBaseUrl, inviteBaseUrl }));
	});

	router.delete("/api/rooms/:code", (req, res) => {
		const result = svc.cleanupRoom(req.params.code, "admin_delete");
		if (!result) return res.status(404).json({ error: "not_found" });
		res.json({ deleted: true, code: req.params.code });
	});

	return router;
}

if (!useFakeSpawn) {
	startHealthcheckLoop({ repo, service, processManager });
}

export { service as roomsService, repo as roomsRepo, portPool, processManager };
export default createRoomsRouter();
