// Diagnostic (2026-07-10): survey roads_v1.json for the playtest edge-bug
// archetypes — slope side-edges vs. lower grass, high flat decks with cliffs,
// multi-layer columns, and GRID (approx) tiles adjacent to exact flats.
// Run: npx tsx tools/diagnose_edge_bugs_survey.ts
import { readFileSync } from "fs";
import { Heightfield, type MapJson } from "../src/shared/heightfield";

const map = JSON.parse(readFileSync("public/maps/roads_v1.json", "utf8")) as MapJson;
const hf = Heightfield.fromMapJson(map);
const tile = map.meta.tile_size;
const [ox, , oz] = map.meta.origin_offset;

// index cells by column
const byCol = new Map<string, Array<{ asset: string; y_level: number; rot: number; mirror?: boolean }>>();
for (const c of map.cells ?? []) {
  const k = c.x + "," + c.z;
  const arr = byCol.get(k) ?? [];
  arr.push({ asset: c.asset, y_level: c.y_level, rot: c.rot ?? 0, mirror: c.mirror });
  byCol.set(k, arr);
}

console.log("=== multi-layer columns ===");
let multi = 0;
for (const [k, arr] of byCol) {
  if (arr.length > 1) {
    multi++;
    if (multi <= 20) console.log(k, JSON.stringify(arr));
  }
}
console.log("total multi-layer columns:", multi);

const SLOPES = new Set(["roadTile_289", "roadTile_246", "roadTile_018", "roadTile_180", "roadTile_152"]);

const worldOf = (gx: number, gz: number) => ({ x: gx * tile + ox, z: gz * tile + oz });

console.log("\n=== slope tiles & side-edge seams ===");
for (const [k, arr] of byCol) {
  const c = arr.find(a => SLOPES.has(a.asset));
  if (!c) continue;
  const [gx, gz] = k.split(",").map(Number);
  const w = worldOf(gx, gz);
  // sample just inside each edge of the slope cell and just outside in neighbor
  const eps = 0.05;
  const half = tile / 2;
  const edges: Array<[string, number, number, number, number]> = [
    ["+X", w.x + half - eps, w.z, w.x + half + eps, w.z],
    ["-X", w.x - half + eps, w.z, w.x - half - eps, w.z],
    ["+Z", w.x, w.z + half - eps, w.x, w.z + half + eps],
    ["-Z", w.x, w.z - half + eps, w.x, w.z - half - eps],
  ];
  const parts: string[] = [];
  for (const [name, ix, iz, ncx, ncz] of edges) {
    const hi = hf.sample(ix, iz);
    const ho = hf.sample(ncx, ncz);
    if (hi === null || ho === null) { parts.push(`${name}:edge-null`); continue; }
    const step = hi - ho;
    if (Math.abs(step) > 0.15) parts.push(`${name}: in=${hi.toFixed(3)} out=${ho.toFixed(3)} step=${step.toFixed(3)}`);
  }
  if (parts.length) console.log(`cell(${k}) ${c.asset} rot=${c.rot} y=${c.y_level} world(${w.x.toFixed(1)},${w.z.toFixed(1)}) | ${parts.join(" | ")}`);
}

console.log("\n=== high flat deck cells with a cliff neighbor (drop > 0.8) ===");
let deckCount = 0;
for (const [k, arr] of byCol) {
  const [gx, gz] = k.split(",").map(Number);
  const w = worldOf(gx, gz);
  const h0 = hf.sample(w.x, w.z);
  if (h0 === null || h0 < 1.2) continue;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const wn = worldOf(gx + dx, gz + dz);
    const hn = hf.sample(wn.x, wn.z);
    if (hn !== null && h0 - hn > 0.8) {
      deckCount++;
      if (deckCount <= 25)
        console.log(`deck cell(${k}) ${arr.map(a => a.asset + "@y" + a.y_level).join("+")} h=${h0.toFixed(3)} -> neighbor(${gx + dx},${gz + dz}) ${byCol.get((gx + dx) + "," + (gz + dz))?.map(a => a.asset).join("+") ?? "OFFMAP"} h=${hn.toFixed(3)}`);
    }
  }
}
console.log("total deck-cliff adjacencies:", deckCount);

console.log("\n=== seams between adjacent cells with |step| > 0.27 at shared-edge midpoint (invisible-wall candidates on same visual level) ===");
let seamCount = 0;
for (const [k] of byCol) {
  const [gx, gz] = k.split(",").map(Number);
  const w = worldOf(gx, gz);
  for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
    const nk = (gx + dx) + "," + (gz + dz);
    if (!byCol.has(nk)) continue;
    const eps = 0.05;
    const ax = w.x + dx * (tile / 2 - eps);
    const az = w.z + dz * (tile / 2 - eps);
    const bx = w.x + dx * (tile / 2 + eps);
    const bz = w.z + dz * (tile / 2 + eps);
    // sample at 5 points along the shared edge
    for (let t = -0.4; t <= 0.401; t += 0.2) {
      const offX = dz !== 0 ? t * tile : 0;
      const offZ = dx !== 0 ? t * tile : 0;
      const ha = hf.sample(ax + offX, az + offZ);
      const hb = hf.sample(bx + offX, bz + offZ);
      if (ha === null || hb === null) continue;
      const step = hb - ha;
      if (Math.abs(step) > 0.27) {
        seamCount++;
        if (seamCount <= 40)
          console.log(`seam ${k} [${byCol.get(k)!.map(a => a.asset).join("+")}] -> ${nk} [${byCol.get(nk)!.map(a => a.asset).join("+")}] t=${t.toFixed(1)} hA=${ha.toFixed(3)} hB=${hb.toFixed(3)} step=${step.toFixed(3)}`);
        break;
      }
    }
  }
}
console.log("total seams with step>0.27:", seamCount);
