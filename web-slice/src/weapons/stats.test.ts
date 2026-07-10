// Pins the reference numbers from docs/p2-port-notes.md §1 so an accidental
// edit doesn't silently drift both the client VFX prediction and the server
// authoritative sim (server/weapons/rocketSim.ts) — both read WEAPON_TYPES.
import { describe, expect, it } from "vitest";
import { WEAPON_TYPES, type ProjectileStats } from "./stats";

describe("WEAPON_TYPES.rocket", () => {
  const rocket = WEAPON_TYPES.rocket as ProjectileStats;

  it("matches the real .tres values (NOT the stale GDD table)", () => {
    expect(rocket.speed).toBe(40); // GDD table says 28 — .tres (real code) says 40
    expect(rocket.lifetime).toBe(6.0); // GDD says 3.5s
    expect(rocket.baseDamage).toBe(40);
    expect(rocket.aoeRadius).toBe(3.5);
    // Owner decision 2026-07-10 (final): NO weapon self-damages its shooter
    // — pinned for the whole kit below.
    expect(rocket.selfDamage).toBe(false);
    expect(rocket.spreadDeg).toBe(10);
  });

  it("always fires the full 3-rocket fan (feel-preserving simplification, no launcher sockets)", () => {
    expect(rocket.volleyCount).toBe(3);
  });
});

describe("self-damage is off across the whole kit (owner decision 2026-07-10)", () => {
  it("no weapon ever damages its own shooter", () => {
    for (const [name, stats] of Object.entries(WEAPON_TYPES)) {
      expect(stats.selfDamage, `${name}.selfDamage`).toBe(false);
    }
  });
});
