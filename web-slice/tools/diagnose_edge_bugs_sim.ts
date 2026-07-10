// Diagnostic (2026-07-10): headless per-tick simulation of the kart's
// probe -> terrainWall -> vertical pipeline on roads_v1.json, using the REAL
// physics modules (no THREE, no rendering). Reproduces playtest bugs A/B.
// Run: npx tsx tools/diagnose_edge_bugs_sim.ts <scenario>
import { readFileSync } from "fs";
import { Heightfield, type MapJson } from "../src/shared/heightfield";
import { sampleGroundProbes, wallAwareGroundHeight } from "../src/kart/groundProbe";
import { createVerticalState, stepVertical, type VerticalState } from "../src/physics/vertical";
import { resolveTerrainSlide, footprintHalfExtents, footprintPoints, type TerrainSampler } from "../src/physics/terrainWall";
import { DEFAULT_KART_PHYSICS_PARAMS, COLLISION_AXLE_GEOMETRY } from "../src/physics/types";

const P = DEFAULT_KART_PHYSICS_PARAMS;
const AXLE = COLLISION_AXLE_GEOMETRY;
const FOOT = footprintHalfExtents(AXLE);
const DT = 1 / 120;
const KART_BODY_HEIGHT = 1.0;

const map = JSON.parse(readFileSync("public/maps/roads_v1.json", "utf8")) as MapJson;
const hf = Heightfield.fromMapJson(map);

function fwdOf(yaw: number) { return { x: -Math.sin(yaw), z: -Math.cos(yaw) }; }
function rightOf(yaw: number) { return { x: Math.cos(yaw), z: -Math.sin(yaw) }; }

// Instrumented copy of terrainWall.cornerBlocked (same math, adds WHY).
const WALL_GRADIENT_BASE = 0.15;
// D5 (2026-07-10): mirrors terrainWall.ts's cornerBlocked body-relative gate
// — GRAD/STEP only count as a wall when the "wall" sample itself is more
// than climbThreshold above yRef. Kept in sync by hand (this is a diagnostic
// copy, not the real function) — see terrainWall.ts's own D5 doc comment.
function cornerBlockedWhy(
  sampler: TerrainSampler,
  cur: { x: number; z: number },
  next: { x: number; z: number },
  dir: { x: number; z: number },
  thr: number,
  yRef: number,
  climbThreshold: number
): string | null {
  const hNext = sampler.sample(next.x, next.z);
  if (hNext === null) return sampler.hasColumn(next.x, next.z) ? null : "OFFMAP";
  const hCur = sampler.sample(cur.x, cur.z);
  if (hCur === null) return null;
  const half = WALL_GRADIENT_BASE / 2;
  const hA = sampler.sample(next.x - dir.x * half, next.z - dir.z * half) ?? hCur;
  const hB = sampler.sample(next.x + dir.x * half, next.z + dir.z * half) ?? hNext;
  const isWallHeight = (h: number) => h > yRef + climbThreshold;
  if (hB - hA > thr && isWallHeight(hB)) return `GRAD hB-hA=${(hB - hA).toFixed(3)} (hA=${hA.toFixed(3)} hB=${hB.toFixed(3)})`;
  if (hNext - hCur > thr && isWallHeight(hNext)) return `STEP hNext-hCur=${(hNext - hCur).toFixed(3)} (cur=${hCur.toFixed(3)} next=${hNext.toFixed(3)})`;
  if (sampler.solidBlocked?.(next.x, next.z)) return "SOLID";
  return null;
}

interface KartSim {
  x: number; z: number; yaw: number;
  vx: number; vz: number;
  vertical: VerticalState;
}

function simulate(name: string, start: { x: number; z: number; yaw: number; speed: number }, ticks: number, opts?: { logEvery?: number }): void {
  console.log(`\n════ SCENARIO: ${name} ════`);
  const y0 = hf.sample(start.x, start.z);
  if (y0 === null) { console.log("start off-map!"); return; }
  const k: KartSim = {
    x: start.x, z: start.z, yaw: start.yaw,
    vx: -Math.sin(start.yaw) * start.speed, vz: -Math.cos(start.yaw) * start.speed,
    vertical: createVerticalState(y0),
  };
  const logEvery = opts?.logEvery ?? 6;
  let lastY = y0;
  for (let t = 0; t < ticks; t++) {
    const yRef = k.vertical.y;
    const fwd = fwdOf(k.yaw);
    const right = rightOf(k.yaw);
    const sampler: TerrainSampler = {
      sample: (x, z) => hf.sampleAt(x, z, yRef, P.layerClimbThreshold),
      hasColumn: (x, z) => hf.hasColumn(x, z),
      solidBlocked: (x, z) => hf.solidBlocked(x, z, yRef, yRef + KART_BODY_HEIGHT, P.layerClimbThreshold),
    };
    // pre-check: which corners would block, and why
    const nx = k.x + k.vx * DT;
    const nz = k.z + k.vz * DT;
    const curPts = footprintPoints(k.x, k.z, fwd, right, FOOT.halfLength, FOOT.halfWidth);
    const nextPts = footprintPoints(nx, nz, fwd, right, FOOT.halfLength, FOOT.halfWidth);
    const speed = Math.hypot(k.vx, k.vz);
    const dir = speed > 0 ? { x: k.vx / speed, z: k.vz / speed } : { x: 0, z: 0 };
    const cornerNames = ["C", "FR", "BR", "FL", "BL"];
    const reasons: string[] = [];
    for (let i = 0; i < curPts.length; i++) {
      const why = cornerBlockedWhy(sampler, curPts[i], nextPts[i], dir, P.terrainWallGradientThreshold, yRef, P.layerClimbThreshold);
      if (why) reasons.push(`${cornerNames[i]}@(${nextPts[i].x.toFixed(2)},${nextPts[i].z.toFixed(2)}): ${why}`);
    }

    const res = resolveTerrainSlide(sampler, { x: k.x, z: k.z }, { x: k.vx, z: k.vz }, DT, fwd, right, FOOT.halfLength, FOOT.halfWidth, P.terrainWallGradientThreshold, yRef, P.layerClimbThreshold);
    k.x = res.pos.x; k.z = res.pos.z; k.vx = res.vel.x; k.vz = res.vel.z;

    const probes = sampleGroundProbes(
      (x, z) => hf.sampleAt(x, z, yRef, P.layerClimbThreshold),
      k.x, k.z, fwd, right, AXLE.wheelbase * 0.5, AXLE.trackWidth * 0.5
    );
    const groundHeightNow = wallAwareGroundHeight(probes, yRef, P.layerClimbThreshold);
    const detachRef = probes.center ?? groundHeightNow;
    const vPrev = k.vertical;
    k.vertical = stepVertical(vPrev, { groundHeight: groundHeightNow, detachRefHeight: detachRef, dt: DT }, {
      gravity: P.verticalGravity,
      groundFollowRate: P.verticalGroundFollowRate,
      airborneDropThreshold: P.verticalAirborneDropThreshold,
      landingMargin: P.verticalLandingMargin,
      groundSnapDistance: P.groundSnapDistance,
    });

    const eventful = reasons.length > 0 || k.vertical.airborne !== vPrev.airborne || Math.abs(k.vertical.y - lastY) > 0.1;
    if (eventful || t % logEvery === 0) {
      const pr = (h: number | null) => (h === null ? "null" : h.toFixed(3));
      console.log(
        `t=${t} pos=(${k.x.toFixed(2)},${k.z.toFixed(2)}) y=${k.vertical.y.toFixed(3)} vy=${k.vertical.vy.toFixed(2)} air=${k.vertical.airborne ? 1 : 0} ` +
        `spd=${Math.hypot(k.vx, k.vz).toFixed(2)} probes[C=${pr(probes.center)} F=${pr(probes.hF)} B=${pr(probes.hB)} R=${pr(probes.hR)} L=${pr(probes.hL)}] ` +
        `gMax=${pr(groundHeightNow)}${reasons.length ? " BLOCKED{" + reasons.join("; ") + "}" : ""}`
      );
    }
    lastY = k.vertical.y;
  }
}

const scenario = process.argv[2] ?? "all";

// ── Bug A: slope side edge, diagonal entry ─────────────────────────────────
// slope roadTile_289 cell(36,39) y_level=0, rot=-90 (ascends world -Z... check
// below), world center (13.5, 22.5), spans x 12..15 z 21..24. Grass 0.55 at
// x>15. Side edges at x=12 & x=15 have a step up to 0.615.
if (scenario === "all" || scenario === "A") {
  // print the slope's height profile first
  console.log("slope cell(36,39) height profile along z (x=13.5):");
  for (let z = 20.5; z <= 24.6; z += 0.5) console.log("  z=" + z.toFixed(1), "h=", hf.sample(13.5, z)?.toFixed(3));
  console.log("side seam at x=15 (grass to the east): h(15.05,22.5)=", hf.sample(15.05, 22.5)?.toFixed(3), " h(14.95,22.5)=", hf.sample(14.95, 22.5)?.toFixed(3));

  // Diagonal approach from grass SE of the slope, heading NW (-X,-Z mix):
  // yaw so that fwd = (-sin yaw, -cos yaw) points at 135°: fwd=(-0.707,-0.707) -> yaw=45° => fwd=(-0.71,-0.71)
  simulate("A: diagonal 45° onto slope side edge (x=15) at 8 m/s", { x: 17.5, z: 26.5, yaw: Math.PI / 4, speed: 8 }, 120);
  simulate("A2: shallow 30°-to-edge diagonal, 8 m/s", { x: 17.5, z: 24.0, yaw: Math.PI / 3, speed: 8 }, 120);
  simulate("A3: frontal climb straight up the slope (control)", { x: 13.5, z: 27.5, yaw: 0, speed: 8 }, 160);
}

// ── Bug B: stacked deck 2.75 (cells 41-43 x 29-41), invisible wall + edge ──
if (scenario === "all" || scenario === "B") {
  // deck world extent: x in [27*... ] cells 41..43 -> centers 28.5,31.5,34.5 (span 27..36)
  // z cells 29..41 -> centers -7.5..28.5
  console.log("deck sample (31.5, 10.5):", hf.sample(31.5, 10.5)?.toFixed(3));
  simulate("B1: drive straight along deck +Z direction (yaw=PI so fwd=+Z... fwd=(0,+1)? yaw=PI -> fwd=(0,1))", { x: 31.5, z: -4.5, yaw: Math.PI, speed: 8 }, 400, { logEvery: 40 });
  simulate("B2: drive across deck toward water canal edge (heading -X? canal at x<27, cells 42,40=(31.5,25.5)... use +X grass edge at x=36)", { x: 31.5, z: 16.5, yaw: -Math.PI / 2, speed: 6 }, 200, { logEvery: 20 });
  simulate("B3: slow creep to deck edge (speed 1.5)", { x: 33.0, z: 16.5, yaw: -Math.PI / 2, speed: 1.5 }, 400, { logEvery: 40 });
}

// ── Systematic false-wall scan over the whole map ──────────────────────────
if (scenario === "all" || scenario === "scan") {
  console.log("\n════ SCAN: false-wall spots (blocked while locally flat) ════");
  let found = 0;
  for (const { x: gx, z: gz } of hf.listCellCoords()) {
    const w = { x: gx * map.meta.tile_size + map.meta.origin_offset[0], z: gz * map.meta.tile_size + map.meta.origin_offset[2] };
    for (const [ox2, oz2] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0]] as const) {
      const px = w.x + ox2 * 1.0;
      const pz = w.z + oz2 * 1.0;
      const yHere = hf.sample(px, pz);
      if (yHere === null) continue;
      const yRef = yHere;
      const sampler: TerrainSampler = {
        sample: (x, z) => hf.sampleAt(x, z, yRef, P.layerClimbThreshold),
        hasColumn: (x, z) => hf.hasColumn(x, z),
        solidBlocked: (x, z) => hf.solidBlocked(x, z, yRef, yRef + KART_BODY_HEIGHT, P.layerClimbThreshold),
      };
      for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const fwd = fwdOf(heading);
        const right = rightOf(heading);
        const speed = 6;
        const vx = fwd.x * speed, vz = fwd.z * speed;
        const nx = px + vx * DT, nz = pz + vz * DT;
        const curPts = footprintPoints(px, pz, fwd, right, FOOT.halfLength, FOOT.halfWidth);
        const nextPts = footprintPoints(nx, nz, fwd, right, FOOT.halfLength, FOOT.halfWidth);
        for (let i = 0; i < curPts.length; i++) {
          // locally flat at the corner? then blocking = false wall
          const hC = sampler.sample(curPts[i].x, curPts[i].z);
          const hN = sampler.sample(nextPts[i].x, nextPts[i].z);
          if (hC === null || hN === null) continue;
          if (Math.abs(hN - hC) > 0.1) continue; // genuinely stepping — not "flat"
          const why = cornerBlockedWhy(sampler, curPts[i], nextPts[i], { x: fwd.x, z: fwd.z }, P.terrainWallGradientThreshold, yRef, P.layerClimbThreshold);
          if (why) {
            found++;
            if (found <= 40)
              console.log(`FALSE-WALL cell(${gx},${gz}) pos(${px.toFixed(1)},${pz.toFixed(1)}) yRef=${yRef.toFixed(2)} heading=${(heading * 180 / Math.PI).toFixed(0)} corner#${i} ${why}`);
          }
        }
      }
    }
  }
  console.log("total false-wall hits:", found);
}

// ── Bug B refined: deck strip (x=34.5, top 2.75) crossing the elevated canal
// roadTile_195@y1 at z-cell 35 (z in [9,12]) — banks flush with deck at 2.75,
// water trench at 1.555 in the middle. ──
if (scenario === "B4") {
  console.log("canal profile along z at x=34.5 (sample = MAX):");
  for (let z = 13.0; z >= 8.9; z -= 0.25) console.log("  z=" + z.toFixed(2), "h=", hf.sample(34.5, z)?.toFixed(3), "sampleAt(yRef=2.75)=", hf.sampleAt(34.5, z, 2.75, 0.8)?.toFixed(3));
  simulate("B4: drive deck strip north across elevated canal, 7 m/s", { x: 34.5, z: 16.5, yaw: 0, speed: 7 }, 250, { logEvery: 15 });
  simulate("B5: creep to canal edge, 1.2 m/s", { x: 34.5, z: 13.5, yaw: 0, speed: 1.2 }, 500, { logEvery: 40 });
}
