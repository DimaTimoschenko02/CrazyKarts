// Chase + diagnostic top-down camera. Reads window.__camMode / __topHeight
// directly (declared + toggled in debug/telemetry.ts) — same debug-toggle
// pattern the rest of the slice uses, no extra plumbing needed for a
// single-camera single-player debug view.
//
// Chase heading (2026-07-07 rework): the chase camera used to be rigidly
// locked to the kart's PHYSICAL yaw, which forced driftVisualOffsetDeg to be
// clamped tiny (10deg) to avoid the whole screen swinging with the drifted
// body. Reference footage of the original SmashKarts shows the camera does
// two things the old rig didn't:
//   1. In a drift the camera tracks the direction the kart is actually
//      MOVING (velocity heading), not the direction the body is pointed —
//      so the drift reads as "the car turned sideways under the camera",
//      not "the whole world spun".
//   2. In reverse the camera does NOT flip 180° to keep facing the kart's
//      new direction of travel — it keeps looking down the nose, so backing
//      up reads as "the kart drives toward the camera".
// Both of those fall out of one rule: blend the camera's heading target
// between velocity-heading and physical-yaw by signed forward speed, with
// velocity-heading winning only while actually moving forward at a real
// clip. See ChaseCamera.update below.
import * as THREE from "three";
import { forwardOf } from "../kart/kart";
import type { KartPhysicsParams } from "../physics/types";

// Normalizes an angle difference into (-PI, PI] so an exp-follow filter (or
// any lerp between two headings) takes the shortest arc instead of spinning
// the long way around at the +-PI wrap boundary — see
// .claude/rules/smooth-values.md. Exported for unit tests.
export function wrapAngle(diff: number): number {
  let d = diff % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Blends two headings across their shortest arc by interpolant t in [0,1] —
// same "wrap before lerp" concern as wrapAngle, phrased as a two-angle mix.
// Exported for unit tests.
export function blendAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

// ── Bridge/overhang occlusion (2026-07-10) ──────────────────────────────
// Owner report: driving under a raised deck (Kenney Road Tiles bridge/
// building floor, ~1.1m+) left the chase camera outside/above the
// overhang, with the kart itself invisible. Fix: cast one ray per frame
// from a point just above the kart toward the desired chase position: if
// map geometry blocks that line of sight, pull the camera in along the
// SAME ray until it's just short of the hit point, instead of leaving it
// stuck on the far side of the deck. See .claude/rules/smooth-values.md —
// the raw hit distance is a discrete per-frame sample (a ray can start/stop
// hitting from one frame to the next as the kart moves), so it's run
// through an exp-follow filter before it ever touches camera.position,
// with two rates: fast getting IN under cover (the view shouldn't stay
// blocked for multiple frames), slower coming back OUT (avoids a visible
// snap the instant the ray clears).

// Raw occlusion fraction for one ray sample: 1.0 = clear line of sight (or
// no hit / degenerate ray), down to 0.0 = the hit point sits right at the
// eye. `margin` pulls the clamp back a little further than the literal hit
// point so the camera sits IN FRONT of the blocking surface, not clipped
// into it. Pure function — exported for unit tests.
export function occlusionFraction(hitDistance: number | null, fullDist: number, margin: number): number {
  if (hitDistance === null || fullDist < 1e-6) return 1;
  return THREE.MathUtils.clamp((hitDistance - margin) / fullDist, 0, 1);
}

// Asymmetric exp-follow: `enterRate` while target is falling (camera
// ducking in under an occluder), `exitRate` while it's rising back toward
// 1 (occluder cleared). Same "two rates for two directions" pattern as
// .claude/rules/smooth-values.md's drift enter/exit example. Exported for
// unit tests.
export function followOcclusion(current: number, target: number, enterRate: number, exitRate: number, dt: number): number {
  const rate = target < current ? enterRate : exitRate;
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

// How far in front of the kart, straight up, the occlusion ray starts —
// roughly windshield height, so a deck that clears the kart's ROOF but
// would still clip a chase view starting exactly at wheel-height correctly
// counts as blocking.
const OCCLUSION_EYE_HEIGHT = 0.5;
// Clamp margin (world meters) kept in front of the hit surface — see
// occlusionFraction doc above.
const OCCLUSION_MARGIN = 0.3;
// Fast duck-under-cover rate vs. slow return-to-normal rate — see the
// asymmetric-filter comment above.
const OCCLUSION_ENTER_RATE = 16;
const OCCLUSION_EXIT_RATE = 4;

export class ChaseCamera {
  // null until the first non-top-mode update — lets the camera SNAP to the
  // kart's actual heading on the very first frame instead of easing in from
  // a hardcoded 0 (which would visibly swing the camera at boot/respawn if
  // the kart doesn't happen to start facing -Z).
  private camYaw: number | null = null;
  // Smoothed occlusion fraction (1 = normal chase distance, 0 = pulled all
  // the way in to the eye point) — see followOcclusion above. Starts at 1
  // (unoccluded) so a kart that spawns in the clear never has to "recover"
  // from a fake initial occlusion.
  private occlusionT = 1;
  // Reused across frames — one allocation for the lifetime of the camera
  // instead of one per frame (this update runs once per rendered frame).
  private raycaster = new THREE.Raycaster();

  update(
    camera: THREE.PerspectiveCamera,
    pos: THREE.Vector3,
    yaw: number,
    velocity: THREE.Vector3,
    params: KartPhysicsParams,
    dt: number,
    // Static map geometry to occlusion-test against (GameMap.root) — pass
    // null to skip the check entirely (e.g. before the map has loaded).
    // Deliberately just the map group, not the whole scene: excludes the
    // kart's own mesh, remote karts, weapon boxes and VFX, none of which
    // should ever hide the camera from its own kart.
    occluders: THREE.Object3D | null = null
  ): void {
    if (window.__camMode === "top") {
      // Diagnostic top-down: high above the kart, north-up — trail arcs and any
      // kinks in them are directly readable.
      // Slight south offset keeps lookAt's up-vector well-conditioned (a dead
      // vertical view makes the roll indeterminate → the map renders "diamond").
      const camTarget = pos.clone()
        .add(new THREE.Vector3(0, window.__topHeight, window.__topHeight * 0.25));
      camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt));
      camera.lookAt(pos.x, pos.y, pos.z);
      return;
    }

    // fwdSigned = velocity projected onto the kart's physical forward axis —
    // same sign convention as bicyclePhysics's fwdSpeed (positive = driving
    // forward, negative = reversing).
    const fwd = forwardOf(yaw);
    const fwdSigned = velocity.x * fwd.x + velocity.z * fwd.z;

    // Heading implied by where the kart is actually going. Only meaningful
    // once blended in below (at fwdSigned <= camVelHeadingBlendLo this term
    // is fully weighted out, so a near-zero/lateral-only velocity vector
    // never gets read as a heading).
    const yawFromVelocity = Math.atan2(-velocity.x, -velocity.z);

    // Continuous smoothstep blend, NOT a binary forward/reverse branch (see
    // .claude/rules/smooth-values.md #4): 0 at/under camVelHeadingBlendLo
    // (pure physical yaw — covers standstill AND reverse), 1 at/over
    // camVelHeadingBlendHi (pure velocity heading — normal forward driving,
    // including drifting).
    const velWeight = THREE.MathUtils.smoothstep(fwdSigned, params.camVelHeadingBlendLo, params.camVelHeadingBlendHi);
    const targetYaw = blendAngle(yaw, yawFromVelocity, velWeight);

    if (this.camYaw === null) {
      this.camYaw = targetYaw;
    } else {
      // Framerate-independent exp-follow, wrapped so it always turns the
      // short way across the +-PI seam instead of snapping 360°.
      this.camYaw += wrapAngle(targetYaw - this.camYaw) * (1 - Math.exp(-params.camYawFollowRate * dt));
    }

    // Chase camera sits BEHIND the kart along the followed heading: behind = -forward.
    const camFwd = forwardOf(this.camYaw);
    const camTarget = pos.clone()
      .addScaledVector(camFwd, -8)
      .add(new THREE.Vector3(0, 5, 0));

    // Bridge/overhang occlusion — see the block comment above the class for
    // the full rationale. eyePoint is a fixed point just above the kart (NOT
    // camera.position — using the current, already-lagging camera position
    // as the ray origin would make the check itself lag behind the kart
    // driving under cover).
    const eyePoint = pos.clone().add(new THREE.Vector3(0, OCCLUSION_EYE_HEIGHT, 0));
    let rawT = 1;
    if (occluders) {
      const toTarget = camTarget.clone().sub(eyePoint);
      const fullDist = toTarget.length();
      if (fullDist > 1e-6) {
        this.raycaster.set(eyePoint, toTarget.clone().normalize());
        this.raycaster.far = fullDist;
        this.raycaster.near = 0;
        const hits = this.raycaster.intersectObject(occluders, true);
        const hitDistance = hits.length > 0 ? hits[0].distance : null;
        rawT = occlusionFraction(hitDistance, fullDist, OCCLUSION_MARGIN);
      }
    }
    this.occlusionT = followOcclusion(this.occlusionT, rawT, OCCLUSION_ENTER_RATE, OCCLUSION_EXIT_RATE, dt);

    // occlusionT === 1 (the overwhelmingly common no-occlusion case) makes
    // this an identity lerp, i.e. finalTarget === camTarget exactly — the
    // normal chase feel is untouched byte-for-byte when nothing is in the way.
    const finalTarget = eyePoint.clone().lerp(camTarget, this.occlusionT);
    camera.position.lerp(finalTarget, 1 - Math.exp(-4 * dt));
    camera.lookAt(pos.x, pos.y + 1, pos.z);
  }
}
