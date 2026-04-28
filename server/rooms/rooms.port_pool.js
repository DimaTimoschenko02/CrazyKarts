export function createPortPool({ start, size }) {
	const all = new Set();
	for (let i = 0; i < size; i++) all.add(start + i);
	const used = new Set();

	function allocate() {
		for (const port of all) {
			if (!used.has(port)) {
				used.add(port);
				return port;
			}
		}
		return null;
	}

	function release(port) {
		used.delete(port);
	}

	function isAllocated(port) {
		return used.has(port);
	}

	function activeCount() {
		return used.size;
	}

	return { allocate, release, isAllocated, activeCount };
}
