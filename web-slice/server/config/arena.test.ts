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
});
