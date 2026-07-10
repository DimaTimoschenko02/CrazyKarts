import { describe, expect, it, afterEach } from "vitest";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadArena } from "./arena";
import { ACTIVE_MAP } from "../../src/shared/activeMap";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.join(__dirname, "../../public/maps");

// loadArena only ever reads from public/maps/<name>.json (mapPathFor), so the
// mtime-invalidation test has to write its scratch fixture directly there —
// cleaned up in afterEach so it never lingers as a real map option in the
// lobby's map picker.
const MTIME_TEST_MAP = "test_mtime_invalidate";
const MTIME_TEST_MAP_PATH = path.join(MAPS_DIR, `${MTIME_TEST_MAP}.json`);

function writeMtimeFixture(boxCount: 1 | 2): void {
  const boxPoints =
    boxCount === 1
      ? [{ x: 2, z: 2, y_level: 1 }]
      : [
          { x: 2, z: 2, y_level: 1 },
          { x: 0, z: 4, y_level: 1 },
        ];
  writeFileSync(
    MTIME_TEST_MAP_PATH,
    JSON.stringify({
      _: "Scratch fixture for arena.test.ts mtime-invalidation — deleted in afterEach.",
      meta: { tile_size: 1.0, level_height: 0.5, origin_offset: [-2, 0, -2] },
      rect_fills: [{ asset: "terrain", x_min: 0, z_min: 0, x_max: 4, z_max: 4, y_level: 1, rot: 0 }],
      box_points: boxPoints,
    })
  );
}

describe("loadArena", () => {
  afterEach(() => {
    if (existsSync(MTIME_TEST_MAP_PATH)) rmSync(MTIME_TEST_MAP_PATH);
  });

  it("loads a valid, existing map name and derives spawn/box points from it", () => {
    const arena = loadArena("arena_slice");
    expect(arena.spawnPoints.length).toBeGreaterThan(0);
    expect(arena.boxPoints.length).toBeGreaterThan(0);
    expect(typeof arena.groundHeightAt({ x: 0, z: 0 })).toBe("number");
  });

  it("returns the SAME cached instance for the same map name when the file hasn't changed", () => {
    expect(loadArena("mars_base")).toBe(loadArena("mars_base"));
  });

  it("re-reads the map when its mtime changes — the editor's Drive-button overwrite must not stay cached (bug 1)", () => {
    writeMtimeFixture(1);
    const before = loadArena(MTIME_TEST_MAP);
    expect(before.boxPoints.length).toBe(1);

    // Bump the mtime forward so the OS clock's own resolution can't coincide
    // with the first write (utimesSync lets us set it explicitly rather than
    // relying on wall-clock time actually advancing between the two writes).
    writeMtimeFixture(2);
    const bumpedMs = Date.now() / 1000 + 5;
    utimesSync(MTIME_TEST_MAP_PATH, bumpedMs, bumpedMs);

    const after = loadArena(MTIME_TEST_MAP);
    expect(after).not.toBe(before);
    expect(after.boxPoints.length).toBe(2);
  });

  it("keeps returning the cached Arena when the file is re-loaded without its mtime changing", () => {
    writeMtimeFixture(1);
    const first = loadArena(MTIME_TEST_MAP);
    const second = loadArena(MTIME_TEST_MAP);
    expect(second).toBe(first);
  });

  it("falls back to ACTIVE_MAP for a name that doesn't exist on disk", () => {
    const fallback = loadArena("this-map-does-not-exist");
    expect(fallback).toBe(loadArena(ACTIVE_MAP));
  });

  it("falls back to ACTIVE_MAP for a name outside the safe charset", () => {
    const fallback = loadArena("../../etc/passwd");
    expect(fallback).toBe(loadArena(ACTIVE_MAP));
  });

  it("falls back to ACTIVE_MAP when no name is given", () => {
    expect(loadArena()).toBe(loadArena(ACTIVE_MAP));
  });

  it("groundHeightAt falls back to the NEAREST walkable cell's real height, not a flat 0, when queried off the heightfield", () => {
    // Regression for the "respawn into the void" report: a stale Arena (old
    // server process still holding a cached instance for a map that got
    // replaced underneath it) or any other off-heightfield query must not
    // silently return 0 — on a map with elevated terrain that teleports the
    // player's Y straight through solid ground below them. Verified against
    // an independently-computed nearest-cell height so this doesn't just
    // re-assert the implementation.
    const arena = loadArena("mars_base");
    const farPoint = { x: 9999, z: 9999 }; // guaranteed off any real map footprint
    expect(arena.heightfield.sample(farPoint.x, farPoint.z)).toBeNull(); // sanity: this point IS off the heightfield

    const coords = arena.heightfield.listCellCoords();
    let nearest = coords[0];
    let bestDistSq = Infinity;
    for (const c of coords) {
      const world = arena.heightfield.gridToWorld(c.x, c.z);
      const distSq = (world.x - farPoint.x) ** 2 + (world.z - farPoint.z) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        nearest = c;
      }
    }
    const nearestWorld = arena.heightfield.gridToWorld(nearest.x, nearest.z);
    const expectedHeight = arena.heightfield.sample(nearestWorld.x, nearestWorld.z);

    expect(arena.groundHeightAt(farPoint)).toBeCloseTo(expectedHeight!, 6);
  });

  it("groundHeightAt still returns the direct sample for an on-heightfield point (fallback path not taken)", () => {
    const arena = loadArena("arena_slice");
    const onMap = arena.spawnPoints[0];
    const direct = arena.heightfield.sample(onMap.x, onMap.z);
    expect(direct).not.toBeNull();
    expect(arena.groundHeightAt(onMap)).toBeCloseTo(direct!, 6);
  });

  it("uses hand-authored box_points (world coords via the same grid->world formula as gridToWorld) when present, instead of auto-deriving", () => {
    const arena = loadArena("test_box_points");
    // Fixture: tile_size=1, origin_offset=[-2,0,-2] -> world = grid + origin.
    expect(arena.boxPoints).toEqual([
      { x: 0, y: 0.5, z: 0 }, // grid (2,2), y_level=1 * level_height=0.5
      { x: -2, y: 0.5, z: 2 }, // grid (0,4), y_level=1 * level_height=0.5
    ]);
  });

  it("box_points y is y_level * meta.level_height (bug 2) — trusts the authored height, not groundHeightAt", () => {
    writeMtimeFixture(1); // y_level=1, level_height=0.5 -> y=0.5
    const arena = loadArena(MTIME_TEST_MAP);
    expect(arena.boxPoints).toEqual([{ x: 0, y: 0.5, z: 0 }]); // grid (2,2) + origin [-2,0,-2]
  });

  it("falls back to the auto-derive when box_points is absent (mars_base has none), using groundHeightAt for y", () => {
    const arena = loadArena("mars_base");
    expect(arena.boxPoints.length).toBeGreaterThan(0);
    for (const p of arena.boxPoints) {
      expect(p.y).toBeCloseTo(arena.groundHeightAt({ x: p.x, z: p.z }), 6);
    }
  });
});
