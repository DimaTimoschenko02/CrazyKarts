// Regression guard for the 2026-07-09 "kart 1.5x bigger, dynamics untouched"
// pass (owner request). Two things must both hold forever:
//   1. Every SIZE (model length, collision footprint, kart-vs-kart radius)
//      scales by the SAME KART_VISUAL_SCALE factor — no drift between them.
//   2. DEFAULT_AXLE_GEOMETRY (what BicyclePhysics actually reads for
//      dynamics) stays at its original tuned numbers — see
//      bicyclePhysics.test.ts's own drift-circle regression guard for the
//      companion check that the FEEL itself hasn't moved.
import { describe, expect, it } from "vitest";
import { KART_TYPES } from "../kart/stats";
import { KART_COLLISION_RADIUS } from "./kartCollision";
import { COLLISION_AXLE_GEOMETRY, DEFAULT_AXLE_GEOMETRY, KART_VISUAL_SCALE } from "./types";

const BASE_MODEL_LENGTH = 1.7; // pre-scale race.glb target length, kart/stats.ts
const BASE_COLLISION_RADIUS = 0.9; // pre-scale kart-vs-kart radius, physics/kartCollision.ts
const BASE_WHEELBASE = 1.2;
const BASE_TRACK_WIDTH = 0.9;

describe("kart visual scale consistency", () => {
  it("KART_VISUAL_SCALE is the owner-requested 1.5x", () => {
    expect(KART_VISUAL_SCALE).toBeCloseTo(1.5, 6);
  });

  it("model length, collision footprint, and kart-vs-kart radius all scale by the exact same factor", () => {
    const modelLengthRatio = KART_TYPES.racer.modelLength / BASE_MODEL_LENGTH;
    const collisionRadiusRatio = KART_COLLISION_RADIUS / BASE_COLLISION_RADIUS;
    const footprintWheelbaseRatio = COLLISION_AXLE_GEOMETRY.wheelbase / BASE_WHEELBASE;
    const footprintTrackRatio = COLLISION_AXLE_GEOMETRY.trackWidth / BASE_TRACK_WIDTH;

    expect(modelLengthRatio).toBeCloseTo(KART_VISUAL_SCALE, 6);
    expect(collisionRadiusRatio).toBeCloseTo(KART_VISUAL_SCALE, 6);
    expect(footprintWheelbaseRatio).toBeCloseTo(KART_VISUAL_SCALE, 6);
    expect(footprintTrackRatio).toBeCloseTo(KART_VISUAL_SCALE, 6);
  });

  it("DEFAULT_AXLE_GEOMETRY (dynamics) is NOT scaled — bicyclePhysics.ts must see the original tuned rig", () => {
    expect(DEFAULT_AXLE_GEOMETRY.wheelbase).toBe(BASE_WHEELBASE);
    expect(DEFAULT_AXLE_GEOMETRY.trackWidth).toBe(BASE_TRACK_WIDTH);
  });

  it("COLLISION_AXLE_GEOMETRY (footprint/probes) is a scaled sibling, not the same object as DEFAULT_AXLE_GEOMETRY", () => {
    expect(COLLISION_AXLE_GEOMETRY).not.toBe(DEFAULT_AXLE_GEOMETRY);
    expect(COLLISION_AXLE_GEOMETRY.wheelbase).toBeCloseTo(BASE_WHEELBASE * KART_VISUAL_SCALE, 6);
    expect(COLLISION_AXLE_GEOMETRY.trackWidth).toBeCloseTo(BASE_TRACK_WIDTH * KART_VISUAL_SCALE, 6);
  });
});
