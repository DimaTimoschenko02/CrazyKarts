// Diagnostic (2026-07-10, "carabканье и дребезг на бортиках дорог" fix —
// see physics/terrainWall.ts TerrainSampler.sameCell doc / shared/
// heightfield.ts Heightfield.cellKeyAt doc / kart/groundProbe.ts
// excludeSameCellWallProbes doc for the root-cause writeup): end-to-end trace
// of a REAL Kart driving into a road-tile-style curb at three angles of
// attack, using the exact SAME modules the browser build runs (Kart.update
// -> resolveTerrainSlide + the ground-height-follow same-cell exclusion).
//
// Curb geometry: hand-authored (NOT pulled from roadTilesCatalog.json) to
// get a clean, ONE-SIDED road-edge curb with a wide flat runway on both
// sides — the real catalog's own curb tiles (e.g. roadTile_182) turned out
// to all be narrow TRAFFIC-ISLAND tiles with a curb on BOTH z-edges and a
// flat lane barely 1.2m wide in the middle, narrower than this kart's own
// 1.8m footprint length — not representative of "driving along a road and
// grazing its edge" (the owner's actual complaint), and it made every
// approach start with the front bumper already resting past the curb
// regardless of speed/angle. Same MAGNITUDE as the real baked tiles though
// (Δ0.66m rise over a ~0.3m run — verified against roadTile_182/228/241's
// baked heightGrid, gameplay-programmer session 2026-07-10), injected as a
// single authored map cell via Heightfield's own internal representation
// (bypassing the road-tile-catalog-only grid authoring path in MapJson,
// which has no "plain custom curb" cell type) so it's still ONE authored
// column start-to-finish — sameCell behaves exactly as it would for a real
// baked road-tile curb.
//
// Run: npx tsx tools/diag_wall_slide.ts [ticks]
import * as THREE from "three";
import { Kart } from "../src/kart/kart";
import { GameMap, type MapJson } from "../src/map/mapLoader";
import { Heightfield } from "../src/shared/heightfield";
import { KART_TYPES } from "../src/kart/stats";
import type { AssetLibrary } from "../src/map/assetLoader";

const DT = 1 / 120;
const ticks = Number(process.argv[2] ?? 240);

// Wide flat runway (tile_size=1, "terrain" cells, height 0.6 to match the
// curb's own low side) for x in [-3,3], z in [-15,0] — well clear of the
// kart's own footprint reach (halfLength 0.9m) at any approach angle. The
// curb cell sits at z=1 (world z in [0.5,1.5]) — ONE authored 1x1m column
// carrying a hand-built sub-cell grid: low (0.6) for the half nearer the
// runway (local z<0), high (1.26, Δ0.66) for the far half (local z>=0),
// with the actual transition packed into a short local-z window
// (matching the real Kenney curb's ~0.3m-over-1m-cell steepness ratio) —
// see buildCurbCell() below for the exact profile.
const RUNWAY_Y = 0.6;
const CURB_TOP_Y = 1.26;

function buildCurbCell(): { grid: number[][] } {
  const n = 12;
  const grid: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      // j indexes local Z (0..n-1 -> local z -0.5..+0.5, see gridSample doc).
      // Transition packed into j=5..7 (roughly local z -0.08..+0.08, i.e. a
      // ~0.25m run at this cell's 1m tile_size) — same physical run length
      // as the real catalog tiles' own curb face.
      let h: number;
      if (j <= 4) h = RUNWAY_Y;
      else if (j >= 8) h = CURB_TOP_Y;
      else h = RUNWAY_Y + ((CURB_TOP_Y - RUNWAY_Y) * (j - 4)) / 4;
      row.push(h);
    }
    grid.push(row);
  }
  return { grid };
}

const map: MapJson = {
  meta: { tile_size: 1, level_height: 0.5, origin_offset: [0, 0, 0] },
  rect_fills: [{ asset: "terrain", x_min: -3, x_max: 3, z_min: -15, z_max: 0, y_level: 0 }],
};
// RUNWAY_Y must match plain "terrain" cells' own height (y_level*level_height
// = 0*0.5 = 0) for a seamless join at z=0/z=0.5 — adjust the curb's low side
// to 0 instead of 0.6 (the road-tile numbers above were just for the
// magnitude comment; the actual runway asset here is flat "terrain" at 0).
const emptyLib: AssetLibrary = new Map();
const gameMap = GameMap.fromJson(map, emptyLib);
const hf = (gameMap as unknown as { heightfield: Heightfield }).heightfield;
const curb = buildCurbCell();
// Rebuild the curb grid against the ACTUAL runway height (0, not 0.6) so
// there's no seam mismatch at z=0.5 (rect_fill's own last row).
for (const row of curb.grid) {
  for (let j = 0; j < row.length; j++) {
    if (j <= 4) row[j] = 0;
    else if (j >= 8) row[j] = 0.66;
    else row[j] = (0.66 * (j - 4)) / 4;
  }
}
(hf as unknown as { setCell: (cx: number, cz: number, cell: unknown) => void }).setCell(0, 1, {
  base: 0,
  rise: 0,
  ax: 0,
  az: 0,
  solidBase: 0,
  grid: curb.grid,
  gridRot: 0,
  gridMirror: false,
});

const y0 = gameMap.sampleHeight(0, -5);
if (y0 === null) { console.log("start off-map — bad test map"); process.exit(1); }

interface TickRow { t: number; y: number; airborne: boolean; omega: number; vx: number; vz: number; z: number; }

function runApproach(angleToWallDeg: number, speed: number): { rows: TickRow[]; summary: string } {
  const scene = new THREE.Scene();
  const startZ = -3;
  const kart = new Kart(scene, KART_TYPES.racer, new THREE.Vector3(0, y0!, startZ));

  // angleToWallDeg: 0 = pure graze (tangential, along the curb's own run —
  // X axis), 90 = dead head-on (pure normal, straight at the curb — Z axis).
  // Curb top sits at +Z ahead (z=0.5..1.5), approaching from z=-5.
  const phi = (angleToWallDeg * Math.PI) / 180;
  const vx = speed * Math.cos(phi); // tangential (along the wall, X)
  const vz = speed * Math.sin(phi); // normal (into the wall, Z)
  kart.state.pos.set(0, y0!, startZ);
  kart.state.vel.set(vx, 0, vz);
  // Align heading with the approach velocity (matches the real playtest
  // case: player steers into the curb at an angle, then the wall contact
  // happens over the next few ticks while roughly holding that heading) —
  // forwardOf(yaw) = (-sin(yaw), -cos(yaw)), solve for yaw matching (vx,vz).
  kart.state.yaw = Math.atan2(-vx, -vz);

  const rows: TickRow[] = [];
  let maxAbsOmega = 0;
  let airborneTicks = 0;
  let maxYJump = 0;
  let prevY = kart.state.pos.y;
  let maxZReached = -Infinity;

  for (let t = 0; t < ticks; t++) {
    // throttle=1 (sustained gas, matching the real playtest case: player
    // holds W while grazing the curb, not coasting) — keeps velocity roughly
    // along the fixed approach heading (steer=0) so the approach angle stays
    // meaningful for the whole run instead of decaying to near-zero speed.
    kart.update(DT, { throttle: 1, steer: 0 }, gameMap);
    const y = kart.state.pos.y;
    const out = kart.lastOutput;
    maxAbsOmega = Math.max(maxAbsOmega, Math.abs(out.omega));
    if (out.airborne) airborneTicks++;
    maxYJump = Math.max(maxYJump, Math.abs(y - prevY));
    prevY = y;
    maxZReached = Math.max(maxZReached, kart.state.pos.z);
    if (t % 20 === 0 || t === ticks - 1) {
      rows.push({ t, y, airborne: out.airborne, omega: out.omega, vx: kart.state.vel.x, vz: kart.state.vel.z, z: kart.state.pos.z });
    }
  }

  const finalSpeed = Math.hypot(kart.state.vel.x, kart.state.vel.z);
  const summary =
    `angle=${angleToWallDeg}deg speed=${speed} -> maxAbsOmega=${maxAbsOmega.toFixed(3)} rad/s, airborneTicks=${airborneTicks}/${ticks}, ` +
    `maxYJump=${maxYJump.toFixed(4)}m, maxZReached=${maxZReached.toFixed(3)} (curb face ~0.0-0.5, top >=0.5), finalSpeed=${finalSpeed.toFixed(2)} m/s`;
  return { rows, summary };
}

console.log("=== tools/diag_wall_slide.ts — road-tile curb wall-slide trace ===");
console.log(`Runway: flat terrain (h=0), curb: hand-authored cell at z=1 (world z in [0.5,1.5]), rise 0->0.66 over local z in [-0.08,+0.08] (world ~0.17m run)`);
console.log(`Kart: ${KART_TYPES.racer.displayName}, ticks=${ticks}, dt=${DT.toFixed(5)}s, start z=-5\n`);

const scenarios: Array<{ angle: number; speed: number }> = [
  { angle: 30, speed: 4 }, // owner playtest range (2-6 m/s)
  { angle: 50, speed: 4 }, // owner's acceptance boundary
  { angle: 90, speed: 4 }, // dead head-on
  { angle: 30, speed: 20 }, // high-speed graze — must not chatter/launch either
];

const summaries: string[] = [];
for (const { angle, speed } of scenarios) {
  const { rows, summary } = runApproach(angle, speed);
  console.log(`--- angle=${angle}deg speed=${speed}m/s ---`);
  console.log("t     y       airborne  omega(rad/s)  vx      vz      z");
  for (const r of rows) {
    console.log(
      `${String(r.t).padStart(4)}  ${r.y.toFixed(3)}  ${r.airborne ? "  1  " : "  0  "}   ${r.omega.toFixed(3).padStart(8)}   ${r.vx.toFixed(2).padStart(6)}  ${r.vz.toFixed(2).padStart(6)}  ${r.z.toFixed(3)}`
    );
  }
  console.log(summary + "\n");
  summaries.push(summary);
}

console.log("=== SUMMARY (all scenarios) ===");
for (const s of summaries) console.log(s);
