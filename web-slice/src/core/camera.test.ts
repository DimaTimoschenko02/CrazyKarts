// Unit coverage for the chase-camera heading math (src/core/camera.ts,
// 2026-07-07 rework — see that file's header for the design rationale). No
// DOM/THREE-renderer needed for the pure-math pieces (wrapAngle/blendAngle);
// ChaseCamera.update is exercised through a stub THREE.PerspectiveCamera
// since it does touch camera.position/lookAt.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { ChaseCamera, wrapAngle, blendAngle, occlusionFraction, followOcclusion } from "./camera";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../physics/types";

// This suite runs under vitest's default node environment (no jsdom — most
// of this codebase's tests are plain-data unit tests with no DOM need), so
// there is no global `window` at all. camera.ts reads `window.__camMode`
// (a debug-toggle read straight off the browser global everywhere else in
// the codebase — see telemetry.ts), so ChaseCamera.update needs a minimal
// stub in place before it's ever called from here.
if (typeof globalThis.window === "undefined") {
  (globalThis as unknown as { window: Window }).window = {} as Window;
}

describe("wrapAngle", () => {
  it("leaves small differences unchanged", () => {
    expect(wrapAngle(0.3)).toBeCloseTo(0.3, 10);
    expect(wrapAngle(-0.3)).toBeCloseTo(-0.3, 10);
  });

  it("wraps a difference just over +PI to the equivalent short negative arc", () => {
    const d = Math.PI + 0.1;
    const wrapped = wrapAngle(d);
    expect(wrapped).toBeCloseTo(-(Math.PI - 0.1), 10);
    expect(Math.abs(wrapped)).toBeLessThan(Math.PI);
  });

  it("wraps a difference just under -PI to the equivalent short positive arc", () => {
    const d = -Math.PI - 0.1;
    const wrapped = wrapAngle(d);
    expect(wrapped).toBeCloseTo(Math.PI - 0.1, 10);
    expect(Math.abs(wrapped)).toBeLessThan(Math.PI);
  });

  it("handles a full-turn-plus difference (multiple wraps)", () => {
    const d = Math.PI * 2 + 0.2;
    expect(wrapAngle(d)).toBeCloseTo(0.2, 10);
  });
});

describe("blendAngle", () => {
  it("returns a at t=0 and b at t=1", () => {
    expect(blendAngle(0.1, 2.5, 0)).toBeCloseTo(0.1, 10);
    expect(blendAngle(0.1, 2.5, 1)).toBeCloseTo(2.5, 10);
  });

  it("takes the short arc across the +-PI seam instead of the long way round", () => {
    // a just under +PI, b just under -PI: the short arc crosses the seam
    // (total distance ~0.2 rad), NOT the long way through 0 (~2*PI - 0.2).
    const a = Math.PI - 0.05;
    const b = -Math.PI + 0.15;
    const mid = blendAngle(a, b, 0.5);
    // Short-arc midpoint should sit just past +PI (i.e. wrap to just past -PI),
    // not near 0 (which is what a naive non-wrapped lerp would produce).
    expect(Math.abs(Math.abs(wrapAngle(mid - a)) )).toBeLessThan(0.2);
  });
});

describe("occlusionFraction", () => {
  it("returns 1 (no pullback) when there is no hit", () => {
    expect(occlusionFraction(null, 10, 0.3)).toBe(1);
  });

  it("returns 1 for a degenerate (near-zero-length) ray regardless of hit", () => {
    expect(occlusionFraction(0.001, 0, 0.3)).toBe(1);
  });

  it("clamps to the hit distance minus margin, as a fraction of the full ray", () => {
    // Full ray 10m, hit at 6m, 0.3m margin -> camera allowed to travel 5.7/10.
    expect(occlusionFraction(6, 10, 0.3)).toBeCloseTo(0.57, 10);
  });

  it("clamps to 0 when the hit is closer than the margin (never goes negative)", () => {
    expect(occlusionFraction(0.1, 10, 0.3)).toBe(0);
  });

  it("clamps to 1 when the hit sits beyond the full ray length (shouldn't happen, but stays sane)", () => {
    expect(occlusionFraction(50, 10, 0.3)).toBe(1);
  });
});

describe("followOcclusion", () => {
  it("moves toward a falling target (ducking under cover) at the fast enter rate", () => {
    const next = followOcclusion(1, 0, /* enterRate */ 16, /* exitRate */ 4, 1 / 60);
    const expected = 1 + (0 - 1) * (1 - Math.exp(-16 * (1 / 60)));
    expect(next).toBeCloseTo(expected, 10);
    expect(next).toBeLessThan(1);
  });

  it("moves toward a rising target (clearing the occluder) at the slow exit rate", () => {
    const next = followOcclusion(0, 1, /* enterRate */ 16, /* exitRate */ 4, 1 / 60);
    const expected = 0 + (1 - 0) * (1 - Math.exp(-4 * (1 / 60)));
    expect(next).toBeCloseTo(expected, 10);
    expect(next).toBeGreaterThan(0);
  });

  it("converges to the target over many frames in either direction", () => {
    let t = 1;
    for (let i = 0; i < 120; i++) t = followOcclusion(t, 0.2, 16, 4, 1 / 60);
    expect(t).toBeCloseTo(0.2, 3);
    for (let i = 0; i < 120; i++) t = followOcclusion(t, 1, 16, 4, 1 / 60);
    expect(t).toBeCloseTo(1, 3);
  });

  it("is a no-op when already at the target", () => {
    expect(followOcclusion(0.5, 0.5, 16, 4, 1 / 60)).toBeCloseTo(0.5, 10);
  });
});

// Minimal stub sufficient for ChaseCamera.update's camera.position.lerp /
// camera.lookAt calls — a real THREE.PerspectiveCamera works fine too, this
// just documents exactly what the method touches.
function makeCamera(): THREE.PerspectiveCamera {
  return new THREE.PerspectiveCamera(70, 1, 0.1, 300);
}

describe("ChaseCamera.update", () => {
  const prevTopMode = window.__camMode;
  beforeEach(() => { window.__camMode = "chase"; });
  afterEach(() => { window.__camMode = prevTopMode; });

  it("snaps to the kart's initial heading on the first update (no easing-in from a hardcoded 0)", () => {
    const cam = new ChaseCamera();
    const camera = makeCamera();
    const pos = new THREE.Vector3(0, 0, 0);
    const yaw = Math.PI; // nose points +Z (opposite of yaw=0's -Z), so "behind the kart" is -Z
    const vel = new THREE.Vector3(0, 0, 0); // standstill -> pure physical yaw target
    cam.update(camera, pos, yaw, vel, DEFAULT_KART_PHYSICS_PARAMS, 1 / 60);
    // camera.position always eases in (its own rate-4 lerp, not under test
    // here), so after a single 1/60s frame it's only crept a little way
    // toward its target either way. What distinguishes "camYaw snapped
    // straight to PI" from "camYaw eased in from a hardcoded 0" is the SIGN
    // of that first step. Snapped: camTarget is already behind yaw=PI (-Z
    // side), so the first step is negative (measured: ~-0.52). If camYaw had
    // instead started at 0 and eased toward PI, the first frame's camYaw
    // would still be close to 0 (only ~0.2 rad in after one exp-follow
    // step), putting camTarget on the WRONG (+Z) side and making the first
    // step positive.
    expect(camera.position.z).toBeLessThan(0);
  });

  it("while reversing (negative forward speed), the target heading stays at the physical yaw, not the direction of travel", () => {
    const cam = new ChaseCamera();
    const camera = makeCamera();
    const pos = new THREE.Vector3(0, 0, 0);
    const yaw = 0; // nose points -Z
    // Reversing: moving in +Z (backward relative to nose) at a speed well
    // above the blend window — if the camera wrongly followed velocity
    // heading here, it would flip to face +Z instead of staying at yaw=0.
    const vel = new THREE.Vector3(0, 0, 5);
    // Run several frames so the exp-follow settles near its target.
    for (let i = 0; i < 60; i++) cam.update(camera, pos, yaw, vel, DEFAULT_KART_PHYSICS_PARAMS, 1 / 60);
    // Behind the kart along yaw=0 forward (-Z) means camera sits at +Z*8 —
    // i.e. the camera stays BEHIND the nose (positive Z), not swung to the
    // opposite side as if it had adopted the reverse-travel heading.
    expect(camera.position.z).toBeGreaterThan(4);
  });

  it("while driving forward fast, the target heading follows velocity direction, not a drifted physical yaw", () => {
    const cam = new ChaseCamera();
    const camera = makeCamera();
    const pos = new THREE.Vector3(0, 0, 0);
    // Physical yaw drifted hard to the side (simulates a deep drift body
    // angle), but velocity still points straight down -Z (the kart is still
    // actually travelling forward, just angled sideways).
    const yaw = Math.PI / 4; // 45deg body angle
    const vel = new THREE.Vector3(0, 0, -10); // travelling straight along -Z
    for (let i = 0; i < 120; i++) cam.update(camera, pos, yaw, vel, DEFAULT_KART_PHYSICS_PARAMS, 1 / 60);
    // Camera should settle behind the kart along the TRAVEL heading (-Z),
    // i.e. camera.position.z well above 0 (behind along -Z means +Z side),
    // and camera.position.x close to 0 — NOT offset toward the drifted
    // yaw=45deg body direction (which would pull position.x negative).
    expect(camera.position.z).toBeGreaterThan(6);
    expect(Math.abs(camera.position.x)).toBeLessThan(1);
  });

  it("pulls the camera in front of an overhead deck instead of leaving it stuck on the far side", () => {
    const cam = new ChaseCamera();
    const camera = makeCamera();
    const pos = new THREE.Vector3(0, 0, 0);
    const yaw = 0; // nose points -Z, camera sits behind at +Z
    const vel = new THREE.Vector3(0, 0, 0);

    // A wide, thin deck straddling the ray from just-above-the-kart to the
    // normal chase position (+Z8, +Y5) — like a bridge floor overhead.
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(20, 0.2, 20),
      new THREE.MeshBasicMaterial()
    );
    deck.position.set(0, 2, 4); // between the kart and the default cam height/offset
    deck.updateMatrixWorld(true);
    const mapRoot = new THREE.Group();
    mapRoot.add(deck);

    for (let i = 0; i < 180; i++) {
      cam.update(camera, pos, yaw, vel, DEFAULT_KART_PHYSICS_PARAMS, 1 / 60, mapRoot);
    }
    // Unoccluded settle position would be (0, 5, 8) — well above/behind the
    // deck. Pulled-in-under-cover, the camera should end up much closer to
    // the kart (both in height and in Z distance) so the kart is visible.
    expect(camera.position.y).toBeLessThan(3);
    expect(camera.position.z).toBeLessThan(5);
  });

  it("stays at the normal chase position when occluders is omitted/null (default behavior unchanged)", () => {
    const cam = new ChaseCamera();
    const camera = makeCamera();
    const pos = new THREE.Vector3(0, 0, 0);
    const yaw = 0;
    const vel = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < 180; i++) cam.update(camera, pos, yaw, vel, DEFAULT_KART_PHYSICS_PARAMS, 1 / 60);
    expect(camera.position.y).toBeCloseTo(5, 1);
    expect(camera.position.z).toBeCloseTo(8, 1);
  });
});
