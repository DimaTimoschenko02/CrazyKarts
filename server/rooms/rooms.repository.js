// In-memory repository for active rooms. SQLite persistence is v2.
export function createRoomsRepository() {
	const byCode = new Map();

	return {
		save(room) {
			byCode.set(room.code, room);
		},
		getByCode(code) {
			return byCode.get(code) || null;
		},
		listActive() {
			const out = [];
			for (const room of byCode.values()) {
				if (room.state !== "CLEANUP") out.push(room);
			}
			return out;
		},
		delete(code) {
			byCode.delete(code);
		},
		getActiveCodes() {
			return new Set(byCode.keys());
		},
		size() {
			return byCode.size;
		},
	};
}
