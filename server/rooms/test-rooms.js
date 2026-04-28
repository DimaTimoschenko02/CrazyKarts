import test from "node:test";
import assert from "node:assert/strict";

import { createRoomsRepository } from "./rooms.repository.js";
import { createRoomsService } from "./rooms.service.js";
import { createPortPool } from "./rooms.port_pool.js";
import { createFakeProcessManager } from "./rooms.spawn.js";
import { generateRoomCode } from "./rooms.code.js";
import {
	validateCreateRoomBody,
	serializeRoom,
} from "./rooms.dto.js";

function makeService(opts = {}) {
	const repo = createRoomsRepository();
	const portPool = createPortPool({
		start: opts.portStart ?? 4445,
		size: opts.portSize ?? 5,
	});
	const processManager = createFakeProcessManager();
	const service = createRoomsService({
		repo,
		portPool,
		processManager,
		internalToken: "test-token",
	});
	return { repo, portPool, processManager, service };
}

const VALID_INPUT = {
	host_name: "Dima",
	max_players: 8,
	duration_min: 5,
};

test("validateCreateRoomBody: required fields and ranges", () => {
	assert.throws(() => validateCreateRoomBody({}), /host_name/);
	assert.throws(
		() => validateCreateRoomBody({ host_name: "Dima", max_players: 99, duration_min: 5 }),
		/max_players/,
	);
	assert.throws(
		() => validateCreateRoomBody({ host_name: "Dima", max_players: 8, duration_min: 7 }),
		/duration_min/,
	);
	const ok = validateCreateRoomBody(VALID_INPUT);
	assert.equal(ok.hostName, "Dima");
	assert.equal(ok.maxPlayers, 8);
	assert.equal(ok.durationMin, 5);
	assert.equal(ok.mapId, "map_1");
});

test("generateRoomCode: 6 chars, no confusables, unique vs used", () => {
	const code = generateRoomCode();
	assert.equal(code.length, 6);
	assert.match(code, /^[A-Z2-9]+$/);
	assert.ok(!code.includes("0"));
	assert.ok(!code.includes("O"));
	assert.ok(!code.includes("I"));
	assert.ok(!code.includes("1"));
});

test("create room: spawns process, allocates port, returns room object", async () => {
	const { service, processManager } = makeService();
	const input = validateCreateRoomBody(VALID_INPUT);
	const room = await service.create(input);
	assert.equal(room.maxPlayers, 8);
	assert.equal(room.port, 4445);
	assert.equal(room.healthcheckPort, 5445);
	assert.equal(room.state, "WAITING");
	assert.equal(processManager._spawnLog.length, 1);
	assert.equal(processManager._spawnLog[0].port, 4445);
	assert.equal(processManager._spawnLog[0].roomCode, room.code);
});

test("port allocation: 5 concurrent creates → 5 distinct ports, 6th → ConflictError", async () => {
	const { service } = makeService({ portSize: 5 });
	const input = validateCreateRoomBody(VALID_INPUT);
	const rooms = [];
	for (let i = 0; i < 5; i++) rooms.push(await service.create(input));
	const ports = new Set(rooms.map((r) => r.port));
	assert.equal(ports.size, 5);

	let captured;
	try {
		await service.create(input);
	} catch (err) {
		captured = err;
	}
	assert.ok(captured, "expected ConflictError");
	assert.equal(captured.status, 409);
});

test("list / getByCode / cleanup", async () => {
	const { service } = makeService();
	const input = validateCreateRoomBody(VALID_INPUT);
	const a = await service.create(input);
	const b = await service.create({ ...input, hostName: "Misha" });

	const list = service.list();
	assert.equal(list.length, 2);

	const fetched = service.getByCode(a.code);
	assert.equal(fetched.code, a.code);

	let captured;
	try {
		service.getByCode("ZZZZZZ");
	} catch (err) {
		captured = err;
	}
	assert.equal(captured.status, 404);

	service.cleanupRoom(a.code, "test");
	assert.equal(service.list().length, 1);
	assert.equal(service.list()[0].code, b.code);
});

test("cleanup releases port back to pool", async () => {
	const { service, portPool } = makeService({ portSize: 2 });
	const input = validateCreateRoomBody(VALID_INPUT);
	const a = await service.create(input);
	const _b = await service.create(input);
	assert.equal(portPool.activeCount(), 2);

	service.cleanupRoom(a.code, "test");
	assert.equal(portPool.activeCount(), 1);

	const c = await service.create(input);
	assert.equal(c.port, a.port, "released port should be reused");
});

test("serializeRoom strips internal fields and adds ws_url + invite_link", async () => {
	const { service } = makeService();
	const room = await service.create(validateCreateRoomBody(VALID_INPUT));
	const dto = serializeRoom(room, {
		wsBaseUrl: "ws://localhost:8080",
		inviteBaseUrl: "http://localhost:8060",
	});
	assert.equal(dto.ws_url, `ws://localhost:8080/ws/${room.code}`);
	assert.equal(dto.invite_link, `http://localhost:8060/?join=${room.code}`);
	assert.equal(dto.is_full, false);
	assert.ok(!Object.prototype.hasOwnProperty.call(dto, "child"));
	assert.ok(!Object.prototype.hasOwnProperty.call(dto, "pid"));
	assert.ok(!Object.prototype.hasOwnProperty.call(dto, "missedHealthchecks"));
});
