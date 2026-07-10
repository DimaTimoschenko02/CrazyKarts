import { describe, expect, it } from "vitest";
import { isBoxPickupInRange } from "./pickupRange";

describe("isBoxPickupInRange", () => {
  const RADIUS = 1.2;
  const VERTICAL = 1.6;

  it("allows pickup when XZ and Y are both within range (same floor)", () => {
    const player = { x: 0, y: 0, z: 0 };
    const box = { x: 0.5, y: 0.5, z: 0 };
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(true);
  });

  it("rejects pickup when XZ distance exceeds the radius, even at the same height", () => {
    const player = { x: 0, y: 0, z: 0 };
    const box = { x: 5, y: 0, z: 0 };
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(false);
  });

  it("rejects pickup when a player drives UNDER a box on a bridge — same XZ, far apart in Y (bug 3)", () => {
    const player = { x: 0, y: 0, z: 0 }; // under the bridge
    const box = { x: 0, y: 5, z: 0 }; // on the bridge deck, directly overhead
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(false);
  });

  it("allows pickup exactly at the vertical boundary", () => {
    const player = { x: 0, y: 0, z: 0 };
    const box = { x: 0, y: VERTICAL, z: 0 };
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(true);
  });

  it("rejects pickup just past the vertical boundary", () => {
    const player = { x: 0, y: 0, z: 0 };
    const box = { x: 0, y: VERTICAL + 0.01, z: 0 };
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(false);
  });

  it("is symmetric regardless of which side player/box height sits on", () => {
    const player = { x: 0, y: 3, z: 0 };
    const box = { x: 0, y: 0, z: 0 };
    expect(isBoxPickupInRange(player, box, RADIUS, VERTICAL)).toBe(false);
  });
});
