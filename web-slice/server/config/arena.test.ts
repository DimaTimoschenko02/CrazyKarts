import { describe, expect, it } from "vitest";
import { loadArena } from "./arena";
import { ACTIVE_MAP } from "../../src/shared/activeMap";

describe("loadArena", () => {
  it("loads a valid, existing map name and derives spawn/box points from it", () => {
    const arena = loadArena("arena_slice");
    expect(arena.spawnPoints.length).toBeGreaterThan(0);
    expect(arena.boxPoints.length).toBeGreaterThan(0);
    expect(typeof arena.groundHeightAt({ x: 0, z: 0 })).toBe("number");
  });

  it("returns the SAME cached instance for the same map name", () => {
    expect(loadArena("mars_base")).toBe(loadArena("mars_base"));
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
});
