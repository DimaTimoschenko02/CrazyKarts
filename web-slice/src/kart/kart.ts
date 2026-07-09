// Kart entity: physics state + placeholder/loaded 3D model + per-substep
// physics update + per-frame visual sync. 1:1 port from GDScript v3.1's
// kart_controller.gd _physics_process wiring (see design/gdd/kart-physics.md
// and kart-physics-v3.2-thermal-fade.md):
//   smooth input → drift signal update → build PhysicsInput → bicycle.step()
//   → yaw += yawDelta + driftYawBonus → velocity ← newVelocity (+assist/boost)
//   → integrate position (with map collision) → visual lean + drift yaw offset.
//
// Axis convention matches Godot: forward = -Z, right = +X, yaw around +Y
// (positive = CCW from above = left turn). The kart mesh nose points -Z.
import * as THREE from "three";
import { BicyclePhysics } from "../physics/bicyclePhysics";
import { ContinuousDrift } from "../physics/driftContinuous";
import { DEFAULT_AXLE_GEOMETRY } from "../physics/types";
import type { DriftOutput, KartPhysicsParams, PhysicsInput, PhysicsState } from "../physics/types";
import { RearSkidMarks } from "../fx/skidMarks";
import { loadKartModel } from "../map/assetLoader";
import type { GameMap } from "../map/mapLoader";
import { buildKartPhysicsParams, type KartStats } from "./stats";
import type { RawInput } from "../core/input";
import { KART_COLLISION_RADIUS, resolveKartPush, type KartObstacle } from "../physics/kartCollision";
import { createVerticalState, stepVertical, type VerticalState } from "../physics/vertical";
import { footprintHalfExtents, footprintPoints, resolveTerrainSlide } from "../physics/terrainWall";
import { resolveKartVsStatic } from "../physics/staticSlide";
import { STATIC_COLLISION_SKIN } from "../shared/staticColliders";
import { computeAttitudeTarget } from "./attitude";
import { wallAwareGroundHeight, sampleGroundProbes, clampHeightForAttitude, clampGroundProbesForAttitude } from "./groundProbe";

// Godot: forward = -Z rotated by yaw around +Y.
export function forwardOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
}
export function rightOf(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
}

// `obstacles` (step 8c below) is now ONLY other connected players' rendered
// karts (net/remoteKarts.ts getObstacles(), no `radius` — always treated as
// KART_COLLISION_RADIUS on both sides). Static map props used to also ride
// in this same list as differently-sized circles (map/mapLoader.ts
// GameMap.getStaticObstacles()) — Collision v2 (design/notes/collision-v2.md)
// moved those to the SAT static-poly path (step 8b above,
// map.getStaticColliders()), so resolveKartPush is kart-vs-kart only now.
// The optional `radius` field is kept on the type for forward-compat (a
// future non-kart push-circle obstacle), not because anything sets it today.
type ObstacleWithOptionalRadius = KartObstacle & { radius?: number };

// Ground-slope sampling for the slope gravity assist (bicyclePhysics.ts
// PhysicsInput.groundSlopeRad) — owner playtest 2026-07-07: "kart climbs a
// ramp at full inertia like flat ground". Probes a fixed distance AHEAD along
// the current heading rather than differencing over a full tile so the raw
// reading tracks the actual ramp face under/just ahead of the nose, not some
// blend with flat ground beyond the ramp's far edge.
const SLOPE_PROBE_DIST = 0.75; // meters ahead of the kart's own position
// Exp-filter rate for the raw slope reading — smooths the step-function jump
// at heightfield tile seams (see .claude/rules/smooth-values.md) without
// meaningfully lagging behind a ramp the kart is actively crossing at speed.
const SLOPE_FILTER_RATE = 18; // 1/s

export interface KartTelemetry {
  fwdSpeed: number;
  sideSpeed: number;
  omega: number;
  driftIntensity: number;
  isDrifting: boolean;
  slipRatio: number;
  rearLat: number;
  engageFactor: number;
  driftActive: boolean;
  driftPower: number;
  rearGripMult: number;
  airborne: boolean;
  vy: number;
}

export class Kart {
  // Outer group carries PHYSICS yaw; inner "baseCar" group carries the
  // visual-only yaw offset (drift lean + drift visual yaw), mirroring the
  // Godot $BaseCar child pattern.
  readonly group = new THREE.Group();
  private readonly baseCar = new THREE.Group();

  private readonly params: KartPhysicsParams;
  private readonly axle = DEFAULT_AXLE_GEOMETRY;
  // Body-footprint probe half-extents for the dynamic terrain-edge slide
  // (see physics/terrainWall.ts) — derived once from the axle geometry, same
  // half-wheelbase/half-track distances kart/groundProbe.ts already probes at.
  private readonly footprintHalf = footprintHalfExtents(this.axle);
  private readonly bicycle: BicyclePhysics;
  private readonly driftSM: ContinuousDrift;
  private readonly skids: RearSkidMarks;
  private readonly spawn: THREE.Vector3;

  readonly state = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
  };

  // Smoothed inputs (kart_controller._smooth_input equivalents).
  private throttleSm = 0;
  private steerSm = 0;
  // Visual lean state (kart_controller._visual_drift_angle equivalent).
  private visualDriftAngle = 0;
  private driftVisualYaw = 0;
  // Vertical (Y-axis) physics — grounded heightfield-follow vs. ballistic
  // airborne, see physics/vertical.ts. Replaces the old bare `groundY`
  // exp-follow field: that one could only ever glue Y to the ground, this
  // one can also detect a launch and fly a real parabola.
  private vertical: VerticalState = createVerticalState(0);
  // Body attitude (pitch/roll) follow state — see kart/attitude.ts for the
  // heightfield-probe math and sign convention.
  private pitchSm = 0;
  private rollSm = 0;
  // Smoothed longitudinal ground slope (radians, +uphill) fed to
  // BicyclePhysics.step as PhysicsInput.groundSlopeRad — see SLOPE_PROBE_DIST/
  // SLOPE_FILTER_RATE above and step 4 below. Frozen (not updated) while
  // airborne, same as the rest of steps 4-7 — see the airborne branch comment.
  private slopeSm = 0;
  // Slow low-pass of BicyclePhysics's own driftIntensity, fed to
  // PhysicsInput.driftPenaltyFactor (see types.ts doc comment for why this
  // filters driftIntensity itself rather than using ContinuousDrift's heat).
  // Rate: params.driftPenaltyTau.
  private driftPenaltySlow = 0;
  // Accumulated sim time (sum of fixed physics dt), fed to skid-mark fade —
  // deliberately NOT performance.now() so this stays deterministic/testable.
  private simTime = 0;

  private lastOut: KartTelemetry = {
    fwdSpeed: 0, sideSpeed: 0, omega: 0,
    driftIntensity: 0, isDrifting: false, slipRatio: 0,
    rearLat: 0, engageFactor: 0, driftActive: false, driftPower: 0,
    rearGripMult: 1, airborne: false, vy: 0,
  };

  constructor(scene: THREE.Scene, stats: KartStats, spawn: THREE.Vector3) {
    this.params = buildKartPhysicsParams(stats);
    this.bicycle = new BicyclePhysics(this.params);
    this.driftSM = new ContinuousDrift(this.params);
    // Skid trails: gameplay marks left only while drifting (see skidMarks.ts).
    this.skids = new RearSkidMarks(scene, this.axle.wheelbase, this.axle.trackWidth);
    this.spawn = spawn.clone();

    this.group.add(this.baseCar);
    this.group.rotation.order = "YXZ"; // yaw first, then slope pitch
    this.buildPlaceholderMesh();
    scene.add(this.group);

    this.reset();
  }

  private buildPlaceholderMesh(): void {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.5, 2.4),
      new THREE.MeshStandardMaterial({ color: 0xff4400 })
    );
    body.position.y = 0.45;
    this.baseCar.add(body);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.4, 1.0),
      new THREE.MeshStandardMaterial({ color: 0x2266ff })
    );
    cabin.position.set(0, 0.85, -0.2);
    this.baseCar.add(cabin);
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.6, 8),
      new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 0.5 })
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.5, -1.4); // -Z = forward
    this.baseCar.add(nose);
  }

  // Swaps the placeholder box kart for the real glb model once it's loaded.
  async loadModel(name: string, targetLength: number): Promise<void> {
    const model = await loadKartModel(name, targetLength);
    this.baseCar.clear();
    this.baseCar.add(model);
  }

  reset(): void {
    this.state.pos.copy(this.spawn);
    this.state.vel.set(0, 0, 0);
    this.state.yaw = 0;
    this.throttleSm = 0;
    this.steerSm = 0;
    this.visualDriftAngle = 0;
    this.driftVisualYaw = 0;
    this.vertical = createVerticalState(this.spawn.y);
    this.pitchSm = 0;
    this.rollSm = 0;
    this.slopeSm = 0;
    this.driftPenaltySlow = 0;
    this.bicycle.reset();
    this.driftSM.reset();
    this.skids.clear();
  }

  // Boot-time spawn-point fallback (main.ts): when the authored SPAWN
  // constant lands off the loaded map's drivable footprint, main.ts finds a
  // walkable cell near the map center (GameMap.findFallbackSpawn()) and
  // re-anchors the kart there BEFORE the first physics tick. Unlike
  // teleport() below (mid-game respawn, keeps the current vertical state),
  // this replaces the spawn point itself and runs the FULL reset() so the
  // new position's ground height seeds `vertical` correctly too.
  respawnAt(pos: THREE.Vector3, yaw = this.state.yaw): void {
    this.spawn.copy(pos);
    this.reset();
    this.state.yaw = yaw;
  }

  // Server-driven respawn teleport (P3 combat slice, server/rooms/MatchRoom.ts
  // respawnPlayer() → "respawn" message). Deliberately separate from reset():
  // that one always returns to the fixed offline-mode spawn point, this one
  // goes wherever the server picked. Clears the same transient physics state
  // reset() does (input smoothing, drift, skid trail) so the kart doesn't
  // arrive mid-drift from wherever it died.
  teleport(x: number, z: number, yaw: number): void {
    this.state.pos.set(x, this.vertical.y, z);
    this.state.vel.set(0, 0, 0);
    this.state.yaw = yaw;
    this.throttleSm = 0;
    this.steerSm = 0;
    this.visualDriftAngle = 0;
    this.driftVisualYaw = 0;
    this.vertical = createVerticalState(this.vertical.y);
    this.pitchSm = 0;
    this.rollSm = 0;
    this.slopeSm = 0;
    this.driftPenaltySlow = 0;
    this.bicycle.reset();
    this.driftSM.reset();
    this.skids.clear();
  }

  get position(): THREE.Vector3 {
    return this.state.pos;
  }
  get velocity(): THREE.Vector3 {
    return this.state.vel;
  }
  get yaw(): number {
    return this.state.yaw;
  }
  get lastOutput(): Readonly<KartTelemetry> {
    return this.lastOut;
  }

  // Live-tunable params object for the dev param panel (src/debug/paramPanel.ts).
  // BicyclePhysics/ContinuousDrift both store this exact object by reference
  // (see their constructors), so mutating a field here takes effect on the
  // very next physics substep — no patch/reapply step needed. The `params`
  // class field stays `readonly` (nobody may rebind it to a new object);
  // this getter only exposes the existing object for in-place field writes.
  get physicsParams(): KartPhysicsParams {
    return this.params;
  }

  private smoothInput(raw: RawInput, dt: number): void {
    const slew = Math.abs(raw.steer) > Math.abs(this.steerSm) ? this.params.steerSlewRateIn : this.params.steerSlewRateOut;
    const steerAlpha = 1 - Math.exp(-slew * dt);
    this.steerSm += (raw.steer - this.steerSm) * steerAlpha;
    if (Math.abs(this.steerSm) < 0.01 && Math.abs(raw.steer) < 0.01) this.steerSm = 0;
    const thrAlpha = 1 - Math.exp(-this.params.throttleSlewRate * dt);
    this.throttleSm += (raw.throttle - this.throttleSm) * thrAlpha;
  }

  // Physics-only step — may run multiple times per rendered frame (fixed
  // substeps). Object3D transform sync happens separately in syncVisual().
  // `obstacles`: other connected players' currently-rendered positions (see
  // net/remoteKarts.ts getObstacles()), used for local-only kart-vs-kart
  // collision (step 8c below) — defaults to none for offline play / tests.
  update(dt: number, raw: RawInput, map: GameMap | null, obstacles: readonly KartObstacle[] = []): void {
    this.simTime += dt;

    // Multi-layer heightfield floor selection (shared/heightfield.ts
    // Heightfield.sampleAt) needs a reference Y to decide which stacked
    // layer this body is near — sampled ONCE here (the map-height carried
    // over from the END of the previous tick's vertical step, i.e. "y before
    // this tick's own vertical step") and reused as one closure for every
    // ground probe this whole tick, per the spec: a probe taken with a
    // DIFFERENT y per query would let the floor selection drift mid-tick
    // instead of answering "what floor is THIS body, at its current height,
    // standing near" consistently.
    const yRef = this.state.pos.y;

    // 1. Input smoothing — kept running even while airborne (see step 5)
    // so a held throttle/steer is already fully "spooled up" the instant
    // the kart lands, instead of popping in with a fresh slew ramp.
    this.smoothInput(raw, dt);

    // `airborne` is this tick's floor state, decided by the vertical step at
    // the END of the PREVIOUS tick (step 8b below) — one-tick-lag, same
    // established pattern as dragMult/rollingMult reading last tick's
    // driftIntensity elsewhere in this codebase. Physics (steering/throttle/
    // drift force) only ever runs while grounded — airborne is pure
    // inertia, per design brief.
    const airborne = this.vertical.airborne;

    // 3. Drift signal BEFORE bicycle (feeds rear_grip_multiplier). Runs even
    // while airborne so ContinuousDrift's own floorGate (see
    // driftContinuous.ts) smoothly fades dFast/visual lean toward 0 instead
    // of a hard cut the instant the kart leaves the ground.
    const fwdDir = forwardOf(this.state.yaw);
    const rightDir = rightOf(this.state.yaw);
    const fwdSigned = this.state.vel.dot(fwdDir);
    const drift = this.driftSM.update(Math.hypot(this.state.vel.x, this.state.vel.z), this.steerSm, !airborne, this.throttleSm, dt);
    this.driftVisualYaw = drift.visualYawOffsetRad;

    if (!airborne) {
      // 4a. Ground slope sample — probe current position vs. SLOPE_PROBE_DIST
      // ahead along heading, exp-filtered to smooth heightfield tile seams
      // (see SLOPE_PROBE_DIST/SLOPE_FILTER_RATE above and .claude/rules/
      // smooth-values.md). Falls back to 0 (flat) whenever either sample is
      // off the map — same "no data, assume level" convention attitude.ts
      // uses for pitch/roll.
      let slopeRaw = 0;
      if (map) {
        const hHere = map.sampleHeightAt(this.state.pos.x, this.state.pos.z, yRef, this.params.layerClimbThreshold);
        const hAhead = map.sampleHeightAt(
          this.state.pos.x + fwdDir.x * SLOPE_PROBE_DIST,
          this.state.pos.z + fwdDir.z * SLOPE_PROBE_DIST,
          yRef,
          this.params.layerClimbThreshold
        );
        if (hHere !== null && hAhead !== null) {
          // Cliff-edge fix (owner playtest report, 2026-07-09): a probe past
          // the lip reads a floor meters below (multi-layer heightfield),
          // read raw that's atan2(-6, dist) ~ -80 deg for a single substep —
          // the reported nose-dive pop. Clamp the DOWNWARD depth this probe
          // is allowed to represent to attitudeCliffDropLimit (uphill/climb
          // readings are untouched — see clampHeightForAttitude doc in
          // groundProbe.ts). Non-null in, non-null out (hHere/hAhead are both
          // checked above), so the cast below is safe.
          const hAheadEff = clampHeightForAttitude(hAhead, hHere, this.params.attitudeCliffDropLimit) as number;
          slopeRaw = Math.atan2(hAheadEff - hHere, SLOPE_PROBE_DIST);
        }
      }
      const slopeAlpha = 1 - Math.exp(-SLOPE_FILTER_RATE * dt);
      this.slopeSm += (slopeRaw - this.slopeSm) * slopeAlpha;

      // 4a2. Slow low-pass of the bicycle's own (last tick's) driftIntensity
      // — see PhysicsInput.driftPenaltyFactor doc comment in types.ts for why
      // this filters driftIntensity itself (not ContinuousDrift's heat).
      // One-tick lag (reads the value from BEFORE this tick's step() call,
      // same established pattern as rearGripMultiplier above).
      const penaltyAlpha = 1 - Math.exp(-(1 / Math.max(this.params.driftPenaltyTau, 0.05)) * dt);
      this.driftPenaltySlow += (this.bicycle.getDriftIntensity() - this.driftPenaltySlow) * penaltyAlpha;

      // 4b. Build PhysicsInput.
      const inp: PhysicsInput = {
        velocity: { x: this.state.vel.x, y: this.state.vel.y, z: this.state.vel.z },
        forward: { x: fwdDir.x, y: 0, z: fwdDir.z },
        right: { x: rightDir.x, y: 0, z: rightDir.z },
        throttle: this.throttleSm,
        steerInput: this.steerSm,
        brakeHeld: raw.throttle < 0,
        onFloor: true,
        rearGripMultiplier: drift.rearGripMultiplier,
        driftPenaltyFactor: this.driftPenaltySlow,
        groundSlopeRad: this.slopeSm,
      };

      // 5. Bicycle physics step.
      const out = this.bicycle.step(inp, dt);

      // 6. Yaw: bicycle delta + drift bonus.
      this.state.yaw += out.yawDelta + drift.yawBonusRadPerSec * dt;

      // 7. Velocity: bicycle XZ, then forward assist + exit boost along POST-rotation forward.
      this.state.vel.set(out.newVelocity.x, 0, out.newVelocity.z);
      const assist = drift.forwardAssistForce + drift.exitBoostForce;
      if (Math.abs(assist) > 0 && fwdSigned >= 0) {
        const fwdAfter = forwardOf(this.state.yaw);
        this.state.vel.addScaledVector(fwdAfter, assist * dt);
      }

      this.updateSkidAndTelemetry(out, drift, dt);
    }
    // Airborne: skip steps 4-7 entirely — no throttle/steer/drift force is
    // applied. state.yaw and state.vel (horizontal) stay exactly what they
    // were at the moment of launch (pure inertia until landing). lastOut /
    // skid trail are simply not refreshed this tick (see
    // updateSkidAndTelemetry) — nothing meaningful changed in the bicycle
    // model since it didn't run; airborne/vy telemetry fields are still
    // refreshed unconditionally at the end of this method.

    // 8. Integrate position with map collision — Collision v2 (design/notes/
    // collision-v2.md). Two collision primitives, chained in this order:
    //   8a. Dynamic terrain-edge slide (physics/terrainWall.ts): handles
    //       genuine off-map boundaries and any too-steep terrain step —
    //       including wall_block*/ground_block cube sides (a full-level 0.5
    //       step, near-vertical over the D3b gradient base), which this path
    //       owns since the 2026-07-08 rework (blocks are walkable on top now,
    //       so their old 2D SAT AABBs are gone — see shared/staticColliders.ts
    //       module doc).
    //       Integrates the candidate XZ move itself and slides tangentially
    //       (I2) instead of killing a whole world axis.
    //   8b. Static SAT contact resolution (physics/staticSlide.ts) against
    //       every prop collider (shared/staticColliders.ts,
    //       shared/collision2d.ts SAT+MTV) — push-out by MTV depth + skin,
    //       slide velocity's normal component (I2). This is what fixes the
    //       old "half a meter of dead air in front of every wall" bug (P1)
    //       and the "puffy circle around a rock" bug (P2): the kart's own
    //       shape is now an OBB (owner-approved §2.1: halfWidth 0.42,
    //       halfLength 0.83) tested against the REAL contour of the
    //       obstacle, not a footprint-radius heightfield probe or a bloated
    //       circle.
    // Both reused whether grounded or airborne (this module doesn't model
    // true 3D walls a flying kart could clear over, only XZ shapes).
    if (map) {
      const fwdNow = forwardOf(this.state.yaw);
      const rightNow = rightOf(this.state.yaw);
      const terrainSampler = {
        sample: (x: number, z: number) => map.sampleHeightAt(x, z, yRef, this.params.layerClimbThreshold),
        hasColumn: (x: number, z: number) => map.hasColumn(x, z),
      };
      const afterTerrain = resolveTerrainSlide(
        terrainSampler,
        { x: this.state.pos.x, z: this.state.pos.z },
        { x: this.state.vel.x, z: this.state.vel.z },
        dt,
        { x: fwdNow.x, z: fwdNow.z },
        { x: rightNow.x, z: rightNow.z },
        this.footprintHalf.halfLength,
        this.footprintHalf.halfWidth,
        this.params.terrainWallGradientThreshold
      );
      const afterStatic = resolveKartVsStatic(
        map.getStaticColliders(),
        afterTerrain.pos,
        afterTerrain.vel,
        { x: rightNow.x, z: rightNow.z },
        { x: fwdNow.x, z: fwdNow.z },
        STATIC_COLLISION_SKIN
      );
      this.state.pos.x = afterStatic.pos.x;
      this.state.pos.z = afterStatic.pos.z;
      this.state.vel.x = afterStatic.vel.x;
      this.state.vel.z = afterStatic.vel.z;
    } else {
      this.state.pos.addScaledVector(this.state.vel, dt);
    }

    // 8c. Kart-kart collision: push the LOCAL kart out of overlap with any
    // OTHER (alive) connected player. Client-side, symmetric-by-construction
    // — the other client runs this same resolution against OUR rendered
    // position independently, no server authority needed for the bump (see
    // network-programmer brief). `obstacles` is now ONLY other players'
    // karts (map static props moved to the SAT path in 8b above — see
    // main.ts wiring, map.getStaticColliders() replaces the old
    // map.getStaticObstacles() circle list). Must not shove the kart through
    // a wall/prop: the pushed position is re-validated against the SAME SAT
    // static colliders (design doc §3.4 step 4 — "толчок не должен
    // пропихнуть в стену").
    if (obstacles.length > 0) {
      const preX = this.state.pos.x;
      const preZ = this.state.pos.z;
      let pushedX = preX;
      let pushedZ = preZ;
      let pushedVelX = this.state.vel.x;
      let pushedVelZ = this.state.vel.z;
      for (const o of obstacles as readonly ObstacleWithOptionalRadius[]) {
        const radius = o.radius !== undefined ? (KART_COLLISION_RADIUS + o.radius) / 2 : KART_COLLISION_RADIUS;
        const res = resolveKartPush({ x: pushedX, z: pushedZ }, { x: pushedVelX, z: pushedVelZ }, [o], radius);
        pushedX = res.pos.x;
        pushedZ = res.pos.z;
        pushedVelX = res.vel.x;
        pushedVelZ = res.vel.z;
      }
      if (map) {
        const fwdNow = forwardOf(this.state.yaw);
        const rightNow = rightOf(this.state.yaw);
        const reValidated = resolveKartVsStatic(
          map.getStaticColliders(),
          { x: pushedX, z: pushedZ },
          { x: pushedVelX, z: pushedVelZ },
          { x: rightNow.x, z: rightNow.z },
          { x: fwdNow.x, z: fwdNow.z },
          STATIC_COLLISION_SKIN
        );
        pushedX = reValidated.pos.x;
        pushedZ = reValidated.pos.z;
        pushedVelX = reValidated.vel.x;
        pushedVelZ = reValidated.vel.z;
        // Off-map guard: a kart-kart shove is rare and small (bounded by the
        // 0.9m collision radius), so a single footprint-corner off-map check
        // (not the full iterative terrain-slide) is enough to stop it from
        // pushing a flank past a genuine map edge.
        const pts = footprintPoints(pushedX, pushedZ, { x: fwdNow.x, z: fwdNow.z }, { x: rightNow.x, z: rightNow.z }, this.footprintHalf.halfLength, this.footprintHalf.halfWidth);
        const offMap = pts.some(p => map.sampleHeight(p.x, p.z) === null && !map.hasColumn(p.x, p.z));
        if (offMap) {
          pushedX = preX;
          pushedZ = preZ;
        }
      }
      this.state.pos.x = pushedX;
      this.state.pos.z = pushedZ;
      this.state.vel.x = pushedVelX;
      this.state.vel.z = pushedVelZ;
    }

    // 8b-vertical. Vertical step (physics/vertical.ts) — grounded
    // heightfield-follow vs. ballistic airborne, decided from the (already
    // horizontally integrated) XZ position above. This is what actually
    // launches the kart off a ramp lip; see that module's header comment for
    // the launch detector's derivation. Feeds NEXT tick's `airborne` const
    // at the top of this method (one-tick lag, same pattern as the drift
    // signal).
    //
    // P3 (design/notes/collision-v2.md §4, I3): groundHeight is now the MAX
    // of the SAME center+F/B/R/L probe set attitude below also uses (one
    // sample budget for both height and pitch/roll) — a rigid body resting
    // in a V-groove or straddling a ridge "mounts" the highest contact point
    // instead of sinking to whatever its own center happens to read.
    // D1 (design/notes/ride-collision-v2.md): wallAwareGroundHeight also
    // excludes any probe reading like a wall (a neighbor's roof, not this
    // body's own ground) — see groundProbe.ts doc for the exact rule.
    const groundProbes = sampleGroundProbes(
      (x, z) => map?.sampleHeightAt(x, z, yRef, this.params.layerClimbThreshold) ?? null,
      this.state.pos.x,
      this.state.pos.z,
      fwdDir,
      rightDir,
      this.axle.wheelbase * 0.5,
      this.axle.trackWidth * 0.5
    );
    const groundHeightNow = wallAwareGroundHeight(groundProbes, this.params.groundStepExcludeThreshold);
    this.vertical = stepVertical(this.vertical, { groundHeight: groundHeightNow, dt }, {
      gravity: this.params.verticalGravity,
      groundFollowRate: this.params.verticalGroundFollowRate,
      airborneDropThreshold: this.params.verticalAirborneDropThreshold,
      landingMargin: this.params.verticalLandingMargin,
      groundSnapDistance: this.params.groundSnapDistance,
    });
    this.state.pos.y = this.vertical.y;

    // 8d. Body attitude (pitch/roll) — follows the heightfield slope under
    // the kart while grounded (see kart/attitude.ts for the probe math and
    // verified sign convention), relaxes to level while airborne. Two-rate
    // exp filter (grounded/airborne), same "different rate each side"
    // pattern as the drift engage/exit rates elsewhere in this codebase.
    // Reuses the SAME groundProbes sampled above for the vertical step (P3).
    // Cliff-edge fix (owner playtest report, 2026-07-09): attitude gets its
    // OWN clamped copy of groundProbes (clampGroundProbesForAttitude,
    // groundProbe.ts) so a probe reading a floor meters below on the far side
    // of a cliff lip can't yank the body's pitch/roll into a hard nose-dive —
    // the vertical/height-follow step above already consumed the RAW
    // groundProbes for launch detection and must keep seeing the real depth.
    const attitudeTarget = this.vertical.airborne
      ? { pitch: 0, roll: 0 }
      : computeAttitudeTarget(
          clampGroundProbesForAttitude(groundProbes, this.params.attitudeCliffDropLimit),
          this.axle.wheelbase * 0.5,
          this.axle.trackWidth * 0.5
        );
    const attitudeRate = this.vertical.airborne ? this.params.attitudeAirborneRelaxRate : this.params.attitudeFollowRate;
    const attitudeAlpha = 1 - Math.exp(-attitudeRate * dt);
    this.pitchSm += (attitudeTarget.pitch - this.pitchSm) * attitudeAlpha;
    this.rollSm += (attitudeTarget.roll - this.rollSm) * attitudeAlpha;

    // airborne/vy telemetry refreshed every tick regardless of grounded
    // state — the rest of lastOut (bicycle-derived fields) is only updated
    // from updateSkidAndTelemetry() above while grounded, see its call site.
    this.lastOut = { ...this.lastOut, airborne: this.vertical.airborne, vy: this.vertical.vy };
  }

  // Skid trail + visual lean + telemetry — only called while grounded (see
  // update() step 5-7): while airborne there is no fresh bicycle output to
  // read (bicycle.step() itself is skipped), so these stay frozen at their
  // last grounded values other than the airborne/vy fields update() always
  // refreshes at the end of the tick.
  private updateSkidAndTelemetry(out: PhysicsState, drift: DriftOutput, dt: number): void {
    // Skid trails: gameplay marks, drawn only while actually drifting.
    // Intensity from actual rear slip normalized like drift_intensity; the
    // engage gate (drift.engageFactor) decides whether anything is recorded
    // at all — see RearSkidMarks.update / engageGateFor.
    const slipNorm = Math.min(Math.abs(out.rearLeftLatSpeed) / Math.max(this.params.driftMaxSlipSpeed, 0.01), 1);
    this.skids.update(this.state.pos, this.state.yaw, slipNorm, drift.engageFactor, this.simTime);

    // 11. Visual lean (omega-driven) — smoothed toward intensity*maxDeg*(-omegaNorm).
    const omegaNorm = Math.min(Math.max(out.omega / Math.max(this.params.omegaLeanScale, 0.01), -1), 1);
    const targetLean = (out.driftIntensity * this.params.visualDriftMaxDeg * -omegaNorm) * Math.PI / 180;
    const leanAlpha = 1 - Math.exp(-this.params.visualLeanRecoverySpeed * dt);
    this.visualDriftAngle += (targetLean - this.visualDriftAngle) * leanAlpha;

    this.lastOut = {
      fwdSpeed: out.fwdSpeed, sideSpeed: out.sideSpeed, omega: out.omega,
      driftIntensity: out.driftIntensity, isDrifting: out.isDrifting, slipRatio: out.slipRatio,
      rearLat: out.rearLeftLatSpeed, engageFactor: drift.engageFactor,
      driftActive: drift.isActive, driftPower: drift.power,
      rearGripMult: drift.rearGripMultiplier,
      airborne: this.vertical.airborne, vy: this.vertical.vy,
    };
  }

  // Object3D transform sync — call once per rendered frame (physics may have
  // run several substeps since the last call).
  syncVisual(): void {
    this.group.position.copy(this.state.pos);
    this.group.rotation.y = this.state.yaw;
    this.group.rotation.x = this.pitchSm; // slope pitch (order YXZ: Z, then X, then Y)
    this.group.rotation.z = this.rollSm; // slope roll
    // Visual-only yaw offset on the inner group ($BaseCar pattern):
    // emergent omega lean + drift visual yaw offset.
    this.baseCar.rotation.y = this.visualDriftAngle + this.driftVisualYaw;
  }
}
