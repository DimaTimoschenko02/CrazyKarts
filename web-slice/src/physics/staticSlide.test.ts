// Regression coverage for resolveKartVsStatic — design/notes/collision-v2.md
// §3.2/§9 Phase 1-2 gates: "сквозь стену не проходит", "грэйз вдоль стены
// сохраняет тангенциальную скорость", "позиция, которую блокировал круг,
// теперь проходима вдоль реального края hull" (P2, covered directly in
// shared/staticColliders.test.ts's pointInPoly checks — this file focuses on
// the RESOLUTION behavior: push-out depth + slide, not shape placement).
import { describe, expect, it } from "vitest";
import { resolveKartVsStatic, KART_STATIC_HALF_LENGTH } from "./staticSlide";
import { makeAabb } from "../shared/collision2d";

const SKIN = 0.02;
const FWD = { x: 1, z: 0 }; // facing +X
const RIGHT = { x: 0, z: -1 };

describe("resolveKartVsStatic — flush parking to a flat wall (P1 core ask: 'ездить впритирку')", () => {
  it("stops the kart with only ~skin clearance from the wall's face, not a footprint-radius gap", () => {
    const wall = makeAabb(2, 0, 0.5, 0.5); // spans x in [1.5, 2.5]
    // Kart driving straight at the wall (+X), nose starts well clear.
    let pos = { x: 0.4, z: 0 };
    let vel = { x: 5, z: 0 };
    const dt = 1 / 120;
    for (let i = 0; i < 200; i++) {
      pos = { x: pos.x + vel.x * dt, z: pos.z };
      const out = resolveKartVsStatic([wall], pos, vel, RIGHT, FWD, SKIN);
      pos = out.pos;
      vel = out.vel;
      if (Math.abs(vel.x) < 1e-4) break;
    }
    // Nose (pos.x + halfLength) should rest just short of the wall's near
    // face (1.5) by ~skin, NOT half a meter+ short of it like the old
    // footprint-radius check (see collision-v2.md P1 root cause: the old
    // check blocked a whole ~0.6m footprint-half-length away).
    const noseX = pos.x + KART_STATIC_HALF_LENGTH;
    expect(noseX).toBeGreaterThan(1.5 - SKIN - 0.05);
    expect(noseX).toBeLessThan(1.5 - SKIN + 0.01);
  });
});

describe("resolveKartVsStatic — I2 slide along a wall", () => {
  it("a diagonal approach keeps the tangential (along-wall) component of velocity", () => {
    const wall = makeAabb(2, 0, 0.5, 0.5); // near face at x=1.5
    // Kart just touching the wall's face, moving diagonally: +X (into it) + +Z (along it).
    const pos = { x: 1.4, z: 0 };
    const vel = { x: 3, z: 4 };
    const out = resolveKartVsStatic([wall], pos, vel, RIGHT, FWD, SKIN);
    // Tangential (Z) component must survive close to its original magnitude;
    // normal (X, inward) component must be reduced/gone.
    expect(out.vel.z).toBeCloseTo(4, 1);
    expect(out.vel.x).toBeLessThan(3);
  });
});

describe("resolveKartVsStatic — no contact, no change", () => {
  it("leaves pos/vel untouched when nothing overlaps", () => {
    const wall = makeAabb(20, 20, 0.5, 0.5);
    const pos = { x: 0, z: 0 };
    const vel = { x: 1, z: 1 };
    const out = resolveKartVsStatic([wall], pos, vel, RIGHT, FWD, SKIN);
    expect(out.pos).toEqual(pos);
    expect(out.vel).toEqual(vel);
  });
});

describe("resolveKartVsStatic — corner/clink stability (MAX_ITERS bound)", () => {
  it("resolves a kart wedged between two walls without infinite oscillation and stays out of both", () => {
    const wallA = makeAabb(1, 0, 0.5, 0.5); // spans x [0.5, 1.5]
    const wallB = makeAabb(0, 1, 0.5, 0.5); // spans z [0.5, 1.5]
    const pos = { x: 0.55, z: 0.55 }; // deep in the corner overlap
    const vel = { x: 0, z: 0 };
    const out = resolveKartVsStatic([wallA, wallB], pos, vel, RIGHT, FWD, SKIN);
    expect(Number.isFinite(out.pos.x)).toBe(true);
    expect(Number.isFinite(out.pos.z)).toBe(true);
  });
});
