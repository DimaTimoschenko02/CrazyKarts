// Diagnostic (2026-07-10): why does Heightfield.solidBlocked fire on flat
// ground next to specific columns? Dumps raw layers + the blocking predicate
// term-by-term. Run: npx tsx tools/diagnose_edge_bugs_solid.ts
import { readFileSync } from "fs";
import { Heightfield, heightCellFor, normRot, type MapJson } from "../src/shared/heightfield";

const map = JSON.parse(readFileSync("public/maps/roads_v1.json", "utf8")) as MapJson;
const hf = Heightfield.fromMapJson(map);
const tile = map.meta.tile_size;
const [ox, , oz] = map.meta.origin_offset;

const byCol = new Map<string, Array<{ asset: string; y_level: number; rot: number; mirror?: boolean }>>();
for (const c of map.cells ?? []) {
  const k = c.x + "," + c.z;
  (byCol.get(k) ?? byCol.set(k, []).get(k)!).push({ asset: c.asset, y_level: c.y_level, rot: c.rot ?? 0, mirror: c.mirror });
}

function dumpColumnAt(wx: number, wz: number, yRef: number): void {
  const gx = Math.round((wx - ox) / tile);
  const gz = Math.round((wz - oz) / tile);
  const cells = byCol.get(gx + "," + gz);
  console.log(`\ncolumn(${gx},${gz}) world center (${(gx * tile + ox).toFixed(1)},${(gz * tile + oz).toFixed(1)}) query (${wx.toFixed(2)},${wz.toFixed(2)}) yRef=${yRef}`);
  if (!cells) { console.log("  (no cells)"); return; }
  const lx = (wx - ox) / tile - gx;
  const lz = (wz - oz) / tile - gz;
  const kartTop = yRef + 1.0;
  const climb = 0.8;
  for (const c of cells) {
    const hc = heightCellFor(c.asset, c.y_level, normRot(c.rot), map.meta.level_height, c.mirror);
    // replicate columnLayers h at this local point
    let h: number;
    if (hc.grid) {
      // cheat: use hf.sample vs others — just print base and note grid
      h = NaN;
    } else {
      let t = Math.min(Math.max(0.5 + lx * hc.ax + lz * hc.az, 0), 1);
      if (hc.ax2 !== undefined || hc.az2 !== undefined) {
        const t2 = Math.min(Math.max(0.5 + lx * (hc.ax2 ?? 0) + lz * (hc.az2 ?? 0), 0), 1);
        t = Math.max(t, t2);
      }
      h = hc.base + hc.rise * t;
    }
    const blocked = h > yRef + climb && hc.solidBase < kartTop && h > yRef;
    console.log(`  ${c.asset}@y${c.y_level} rot=${c.rot}${c.mirror ? " MIRROR" : ""} ${hc.grid ? "GRID" : ""} base=${hc.base.toFixed(3)} h(point)=${isNaN(h) ? "grid" : h.toFixed(3)} solidBase=${hc.solidBase.toFixed(3)} | h>yRef+0.8? ${isNaN(h) ? "?" : h > yRef + climb} solidBase<kartTop(${kartTop.toFixed(2)})? ${hc.solidBase < kartTop} h>yRef? ${isNaN(h) ? "?" : h > yRef} => BLOCK=${blocked}`);
  }
  console.log("  hf.solidBlocked =", hf.solidBlocked(wx, wz, yRef, yRef + 1.0, 0.8), " sample=", hf.sample(wx, wz)?.toFixed(3), " sampleAt(yRef)=", hf.sampleAt(wx, wz, yRef, 0.8)?.toFixed(3));
}

// scan hits from diagnose_edge_bugs_sim.ts:
// cell(33,30) pos(3.5,-5.5) heading 0 corner#1 (FR: +right +fwd) — fwd=(0,-1) right=(1,0): corner at (3.5+0.675, -5.5-0.9)
dumpColumnAt(3.5 + 0.675, -5.5 - 0.9 - 0.05, 1.65);
// what's in column (33,29)? cell(33,30) center (4.5,-4.5); corner probes reach z=-6.45 → gz = round((-6.45+94.5)/3)=round(29.35)=29
dumpColumnAt(4.5, -7.5, 1.65);
// cell(39,33) pos(23.5,3.5) yRef=0.60 heading 0 corner#1
dumpColumnAt(23.5 + 0.675, 3.5 - 0.95, 0.6);
// deck stack neighbors: (41,41) pos(27.5,27.5) heading 0 corner#4 (BL: -right -fwd → (26.825, 28.4))
dumpColumnAt(26.825, 28.4 + 0.05, 2.75);
// and the canal-vs-deck boundary from B3
dumpColumnAt(32.9, 16.5, 2.75);
dumpColumnAt(33.5, 16.5, 1.555);
