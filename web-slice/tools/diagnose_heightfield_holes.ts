// Diagnostic script (not a test) — investigates the "kart falls through the
// map in some spots" owner report on public/maps/map_as_an_example.json.
// Pure read-only inspection of Heightfield.fromMapJson output; never edits
// the map file.
//
// Checks performed:
//   1. Null-column holes STRICTLY INSIDE the map footprint (a walkable cell
//      whose 4 orthogonal neighbors are ALL walkable, i.e. not an outer-edge
//      cell) — these are candidate "invisible pit" bugs, since kart.ts step 8
//      treats a null sample as a wall/cliff, and a hole surrounded by
//      walkable ground on every side means the kart's own column can go null
//      while it's mid-tile, which is exactly the vertical.y ?? fallback path
//      (kart.ts:367) that lets a kart silently sink.
//   2. Cells whose asset name looks sloped (matches /ramp|side|corner|cliff/i)
//      but for which heightCellFor() silently falls through to the flat
//      catch-all (rise === 0) — a missing branch, not a hole, but the same
//      symptom (physics height disagrees with the visual mesh).
//   3. Mirror-flag proof: for every cell with mirror:true, compares the
//      ax/az gradient heightCellFor() currently returns against what the
//      SAME cell would get if mirror were ignored — flags cases where they
//      differ (these are exactly the cells where physics and the rendered
//      mirrored mesh disagree on which corner is high).
//   4. Height discontinuities > 0.3m between orthogonally-adjacent 0.1m
//      samples inside the walkable area — legal walls, just listed for
//      visibility (matches kart.ts's own MAX_STEP).
//
// Run: npx tsx tools/diagnose_heightfield_holes.ts [path-to-map.json]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Heightfield, heightCellFor, normRot, type MapJson, type CellDef, type RectFill } from "../src/shared/heightfield";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapArg = process.argv[2] ?? "public/maps/map_as_an_example.json";
const mapPath = path.isAbsolute(mapArg) ? mapArg : path.join(__dirname, "..", mapArg);

const mapJson = JSON.parse(readFileSync(mapPath, "utf-8")) as MapJson;
const hf = Heightfield.fromMapJson(mapJson);

console.log(`Map: ${mapPath}`);
console.log(`Meta: tile=${mapJson.meta.tile_size} level_height=${mapJson.meta.level_height}`);
console.log("");

// ── 1. Null-column holes strictly inside the footprint ─────────────────────
const walkable = new Set<string>();
for (const c of hf.listCellCoords()) walkable.add(c.x + "," + c.z);
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const c of hf.listCellCoords()) {
  minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
  minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
}

const interiorHoles: Array<{ x: number; z: number }> = [];
for (let x = minX; x <= maxX; x++) {
  for (let z = minZ; z <= maxZ; z++) {
    if (walkable.has(x + "," + z)) continue; // not a hole, it's walkable
    // "strictly inside": all 4 orthogonal neighbors ARE walkable.
    const neighbors: [number, number][] = [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]];
    const surrounded = neighbors.every(([nx, nz]) => walkable.has(nx + "," + nz));
    if (surrounded) interiorHoles.push({ x, z });
  }
}
console.log(`── 1. Interior null-column holes: ${interiorHoles.length} ──`);
for (const h of interiorHoles) console.log(`   (${h.x}, ${h.z})`);
console.log("");

// ── 2. Sloped-looking assets that silently fall to the flat catch-all ─────
const SLOPE_LOOKING = /ramp|side|corner|cliff/i;
function collectAllCells(): Array<{ asset: string; x: number; z: number; y_level: number; rot: number; mirror?: boolean }> {
  const out: Array<{ asset: string; x: number; z: number; y_level: number; rot: number; mirror?: boolean }> = [];
  for (const r of (mapJson.rect_fills ?? []) as RectFill[]) {
    const rot = normRot(r.rot);
    for (let x = r.x_min; x <= r.x_max; x++) {
      for (let z = r.z_min; z <= r.z_max; z++) out.push({ asset: r.asset, x, z, y_level: r.y_level, rot });
    }
  }
  for (const c of (mapJson.cells ?? []) as CellDef[]) {
    out.push({ asset: c.asset, x: c.x, z: c.z, y_level: c.y_level, rot: normRot(c.rot), mirror: c.mirror });
  }
  return out;
}
const allCells = collectAllCells();
const missingBranch = allCells.filter(c => {
  if (!SLOPE_LOOKING.test(c.asset)) return false;
  const cell = heightCellFor(c.asset, c.y_level, c.rot, mapJson.meta.level_height);
  return cell.rise === 0; // fell through to the flat/unknown catch-all
});
console.log(`── 2. Sloped-looking assets that silently resolve flat (rise=0): ${missingBranch.length} ──`);
for (const m of missingBranch.slice(0, 50)) {
  console.log(`   asset=${m.asset} x=${m.x} z=${m.z} y_level=${m.y_level} rot=${m.rot}`);
}
if (missingBranch.length > 50) console.log(`   ... and ${missingBranch.length - 50} more`);
const missingByAsset = new Map<string, number>();
for (const m of missingBranch) missingByAsset.set(m.asset, (missingByAsset.get(m.asset) ?? 0) + 1);
console.log("   by asset:", Object.fromEntries(missingByAsset));
console.log("");

// ── 3. Mirror-flag proof ────────────────────────────────────────────────
const mirroredCells = allCells.filter(c => c.mirror);
let mirrorMismatchCount = 0;
console.log(`── 3. mirror:true cells: ${mirroredCells.length} ──`);
for (const c of mirroredCells) {
  const withMirror = heightCellFor(c.asset, c.y_level, c.rot, mapJson.meta.level_height, true);
  const withoutMirror = heightCellFor(c.asset, c.y_level, c.rot, mapJson.meta.level_height, false);
  const differs =
    withMirror.ax !== withoutMirror.ax ||
    withMirror.az !== withoutMirror.az ||
    withMirror.ax2 !== withoutMirror.ax2 ||
    withMirror.az2 !== withoutMirror.az2;
  if (differs) {
    mirrorMismatchCount++;
    console.log(
      `   MISMATCH asset=${c.asset} x=${c.x} z=${c.z} rot=${c.rot} ` +
        `mirrored(ax=${withMirror.ax},az=${withMirror.az}) vs unmirrored(ax=${withoutMirror.ax},az=${withoutMirror.az})`
    );
  }
}
console.log(`   ${mirrorMismatchCount}/${mirroredCells.length} mirrored cells produce a DIFFERENT gradient than ignoring mirror.`);
console.log("");

// ── 4. Height discontinuities > 0.3m (informational — legal walls) ────────
const STEP = 0.1;
const MAX_STEP = 0.3;
const worldMinX = minX * mapJson.meta.tile_size + mapJson.meta.origin_offset[0];
const worldMaxX = maxX * mapJson.meta.tile_size + mapJson.meta.origin_offset[0];
const worldMinZ = minZ * mapJson.meta.tile_size + mapJson.meta.origin_offset[2];
const worldMaxZ = maxZ * mapJson.meta.tile_size + mapJson.meta.origin_offset[2];

let discontinuities = 0;
const sampleGrid: Array<Array<number | null>> = [];
const nx = Math.round((worldMaxX - worldMinX) / STEP) + 1;
const nz = Math.round((worldMaxZ - worldMinZ) / STEP) + 1;
for (let ix = 0; ix < nx; ix++) {
  const row: Array<number | null> = [];
  const wx = worldMinX + ix * STEP;
  for (let iz = 0; iz < nz; iz++) {
    const wz = worldMinZ + iz * STEP;
    row.push(hf.sample(wx, wz));
  }
  sampleGrid.push(row);
}
for (let ix = 0; ix < nx; ix++) {
  for (let iz = 0; iz < nz; iz++) {
    const h = sampleGrid[ix][iz];
    if (h === null) continue;
    const right = ix + 1 < nx ? sampleGrid[ix + 1][iz] : null;
    const down = iz + 1 < nz ? sampleGrid[ix][iz + 1] : null;
    if (right !== null && Math.abs(right - h) > MAX_STEP) discontinuities++;
    if (down !== null && Math.abs(down - h) > MAX_STEP) discontinuities++;
  }
}
console.log(`── 4. Height discontinuities > ${MAX_STEP}m between adjacent 0.1m samples (informational, legal walls): ${discontinuities} ──`);
console.log("");
console.log("Done.");
