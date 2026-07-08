// Bakes a physics/palette catalog for the Kenney "3D Road Tiles" pack
// (public/assets/roads/roadTile_NNN.gltf, 302 tiles) — the pack's file names
// carry zero semantics, so everything the editor palette and the heightfield
// need to know is derived here from the raw geometry, once, offline:
//
//   node tools/bake-road-tiles.mjs        → shared/roadTilesCatalog.json
//                                          + ../docs/roads-catalog.md
//
// Per tile we sample a grid of vertical columns against the triangle soup
// (same "read the raw vertices, never trust a screenshot" doctrine as
// .claude/rules/map-building.md) and derive:
//   - the top drivable surface per column (max ray hit) + its material
//   - flat / axis-slope classification via a least-squares plane fit
//   - road connectivity (which tile edges asphalt touches) → straight /
//     corner / T / cross / end labels for flat road pieces
//   - underpasses (a second surface below the top one with enough clearance
//     to drive under) → the "bridge" category; our column heightfield can't
//     represent drive-under yet, so these are flagged physics:"approx"
//   - water coverage by material name (the pack has a literal "Water" material)
//
// The catalog is data (JSON), not code: shared/heightfield.ts and
// shared/mapAssets.ts consume it so adding/reclassifying tiles never touches
// physics code. kind → physics contract:
//   flat        physics "exact"  — one height for the whole tile (median top)
//   slope       physics "exact"  — linear axis-aligned gradient (base + rise)
//   bridge/misc physics "approx" — treated as flat at the median top height
//   water       physics "approx" — flat; gameplay meaning TBD by the owner
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "..", "public", "assets", "roads");
const OUT_JSON = path.join(HERE, "..", "src", "shared", "roadTilesCatalog.json");
const OUT_MD = path.join(HERE, "..", "..", "docs", "roads-catalog.md");

// Column sampling resolution across the tile footprint. 24×24 on a 3×3m tile
// = one sample every 12.5cm — fine enough to see curbs and lane edges, coarse
// enough to bake all 302 tiles in seconds.
const GRID = 24;
// Two ray hits in one column closer than this are the same surface (a curb
// lip, a rail top) — farther apart they are distinct layers (bridge deck vs
// ground below).
const LAYER_MERGE_EPS = 0.3;
// Minimum vertical clearance between two layers for a kart to plausibly
// drive UNDER the top one. Kart visual height ≈ 0.6m at world scale; the
// pack's own underpasses measure ~1.3m+, so 0.9 cleanly separates real
// underpasses from double-decked geometry noise.
const UNDERPASS_CLEARANCE = 0.9;
// Fraction of columns that must have an underpass for the tile to be a
// bridge (a couple of noisy columns under a rail overhang shouldn't count).
const BRIDGE_COLUMN_FRAC = 0.05;
// Plane-fit residual (RMS, meters) below which the top surface counts as an
// exact plane: flat (gradient ≈ 0) or a straight slope.
const PLANE_RMS_MAX = 0.05;
// Gradient magnitude (m of rise per m of run) below which a fitted plane is
// "flat" — 0.02 tolerates curb-induced tilt on flat road pieces.
const FLAT_GRADIENT_MAX = 0.02;
// An axis-aligned slope must have ≥95% of its gradient on one axis; anything
// more diagonal is a corner-slope / curved transition → misc (approx).
const AXIS_DOMINANCE = 0.95;

const ASPHALT_MATERIALS = new Set(["Asphalt", "Grey_Asphalt", "Light_Asphalt"]);

// ── glTF reading (JSON container, embedded base64 buffers — obj2gltf output,
// verified: single node, no transforms, no external files) ─────────────────

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function decodeBuffers(gltf) {
  return (gltf.buffers ?? []).map(b => {
    const prefix = "base64,";
    const i = b.uri.indexOf(prefix);
    if (i < 0) throw new Error("non-embedded buffer");
    return Buffer.from(b.uri.slice(i + prefix.length), "base64");
  });
}

function readAccessor(gltf, buffers, index) {
  const acc = gltf.accessors[index];
  const view = gltf.bufferViews[acc.bufferView];
  const buf = buffers[view.buffer];
  const compBytes = COMPONENT_BYTES[acc.componentType];
  const comps = TYPE_COUNT[acc.type];
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? compBytes * comps;
  const out = new Array(acc.count);
  for (let i = 0; i < acc.count; i++) {
    const base = start + i * stride;
    const el = new Array(comps);
    for (let c = 0; c < comps; c++) {
      const off = base + c * compBytes;
      switch (acc.componentType) {
        case 5126: el[c] = buf.readFloatLE(off); break;
        case 5125: el[c] = buf.readUInt32LE(off); break;
        case 5123: el[c] = buf.readUInt16LE(off); break;
        case 5121: el[c] = buf.readUInt8(off); break;
        default: throw new Error("unsupported componentType " + acc.componentType);
      }
    }
    out[i] = comps === 1 ? el[0] : el;
  }
  return out;
}

// Flattens every mesh primitive into triangles [{a,b,c,material}] — node
// transforms are identity across the whole pack (verified on 302 files:
// every node is bare {name, mesh}), so positions are used as-is; assert
// that instead of silently mis-baking if a future re-export adds transforms.
function readTriangles(gltf, buffers) {
  for (const node of gltf.nodes ?? []) {
    if (node.matrix || node.translation || node.rotation || node.scale) {
      throw new Error("node transforms present — bake needs a transform walk now");
    }
  }
  const tris = [];
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const pos = readAccessor(gltf, buffers, prim.attributes.POSITION);
      const idx = prim.indices !== undefined
        ? readAccessor(gltf, buffers, prim.indices)
        : pos.map((_, i) => i);
      const material = prim.material !== undefined ? gltf.materials[prim.material]?.name ?? "?" : "?";
      for (let i = 0; i + 2 < idx.length; i += 3) {
        tris.push({ a: pos[idx[i]], b: pos[idx[i + 1]], c: pos[idx[i + 2]], material });
      }
    }
  }
  return tris;
}

// ── column sampling ─────────────────────────────────────────────────────────

// True when the triangle's geometric normal points up (a floor you can stand
// on) rather than down (a ceiling / underside). Uses the actual winding, not
// authored normals — obj2gltf keeps consistent CCW winding.
function isFloor(tri) {
  const { a, b, c } = tri;
  const ny = (c[0] - a[0]) * (b[2] - a[2]) - (c[2] - a[2]) * (b[0] - a[0]);
  return ny >= 0;
}

// Y of the triangle's plane at (x,z) if the vertical line pierces its XZ
// projection, else null. Degenerate (vertical) triangles project to zero
// area and are skipped — walls don't have a "top" to stand on.
function columnHit(tri, x, z) {
  const { a, b, c } = tri;
  const v0x = c[0] - a[0], v0z = c[2] - a[2];
  const v1x = b[0] - a[0], v1z = b[2] - a[2];
  const v2x = x - a[0], v2z = z - a[2];
  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denom) < 1e-12) return null;
  const u = (dot11 * dot02 - dot01 * dot12) / denom;
  const v = (dot00 * dot12 - dot01 * dot02) / denom;
  if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) return null;
  return a[1] + u * (c[1] - a[1]) + v * (b[1] - a[1]);
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function analyzeTile(tris) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }

  const samples = []; // {x, z, top, material, gap}
  let covered = 0, underpass = 0;
  const materialArea = new Map();
  for (let ix = 0; ix < GRID; ix++) {
    for (let iz = 0; iz < GRID; iz++) {
      const x = minX + ((ix + 0.5) / GRID) * (maxX - minX);
      const z = minZ + ((iz + 0.5) / GRID) * (maxZ - minZ);
      const hits = [];
      for (const t of tris) {
        const y = columnHit(t, x, z);
        if (y !== null) hits.push({ y, material: t.material, floor: isFloor(t) });
      }
      if (!hits.length) { samples.push(null); continue; }
      hits.sort((h1, h2) => h2.y - h1.y);
      covered++;
      const top = hits[0];
      // A drive-under exists only where a FLOOR (up-facing face) lies below a
      // CEILING (down-facing face, e.g. a bridge deck's underside) with real
      // clearance between them. A solid embankment column has hits (top floor,
      // bottom ceiling at y≈minY) but no floor UNDER that ceiling — no gap.
      let gap = 0;
      for (let i = 0; i < hits.length; i++) {
        if (!hits[i].floor || hits[i] === top) continue;
        // nearest ceiling above this floor
        let ceiling = null;
        for (let j = i - 1; j >= 0; j--) {
          if (!hits[j].floor) ceiling = hits[j].y; // hits sorted desc → last down-face wins (lowest ceiling above)
        }
        if (ceiling !== null && ceiling - hits[i].y > LAYER_MERGE_EPS) {
          gap = Math.max(gap, ceiling - hits[i].y);
        }
      }
      if (gap >= UNDERPASS_CLEARANCE) underpass++;
      materialArea.set(top.material, (materialArea.get(top.material) ?? 0) + 1);
      samples.push({ x, z, top: top.y, material: top.material, gap });
    }
  }

  // Least-squares plane fit y = p0 + gx*x + gz*z over the top surface.
  const pts = samples.filter(Boolean);
  let gx = 0, gz = 0, p0 = 0, rms = Infinity;
  if (pts.length >= 8) {
    const n = pts.length;
    let sx = 0, sz = 0, sy = 0, sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0;
    for (const p of pts) {
      sx += p.x; sz += p.z; sy += p.top;
      sxx += p.x * p.x; szz += p.z * p.z; sxz += p.x * p.z;
      sxy += p.x * p.top; szy += p.z * p.top;
    }
    // Normal equations for [p0, gx, gz]
    const A = [[n, sx, sz], [sx, sxx, sxz], [sz, sxz, szz]];
    const B = [sy, sxy, szy];
    const sol = solve3(A, B);
    if (sol) {
      p0 = sol[0]; gx = sol[1]; gz = sol[2];
      let se = 0;
      for (const p of pts) {
        const e = p.top - (p0 + gx * p.x + gz * p.z);
        se += e * e;
      }
      rms = Math.sqrt(se / n);
    }
  }

  const tops = pts.map(p => p.top).sort((a, b) => a - b);
  const topMedian = tops.length ? median(tops) : 0;
  const topMin = tops.length ? tops[0] : 0;
  const topMax = tops.length ? tops[tops.length - 1] : 0;

  // Which tile edges does asphalt reach? Sample the outermost ring of columns
  // per edge; an edge "connects" when ≥25% of its ring columns are asphalt-
  // topped (a 2-lane road on a 3m tile covers ~2/3 of the edge; 25% still
  // catches single-lane pieces without firing on stray curb pixels).
  const edgeConn = { px: 0, nx: 0, pz: 0, nz: 0 };
  const edgeTotal = { px: 0, nx: 0, pz: 0, nz: 0 };
  for (let i = 0; i < GRID; i++) {
    for (const [edge, ix, iz] of [
      ["nx", 0, i], ["px", GRID - 1, i], ["nz", i, 0], ["pz", i, GRID - 1],
    ]) {
      const s = samples[ix * GRID + iz];
      edgeTotal[edge]++;
      if (s && ASPHALT_MATERIALS.has(s.material)) edgeConn[edge]++;
    }
  }
  const edges = {};
  for (const e of ["px", "nx", "pz", "nz"]) edges[e] = edgeConn[e] / Math.max(1, edgeTotal[e]) >= 0.25;

  const matFracs = {};
  for (const [m, count] of materialArea) matFracs[m] = +(count / Math.max(1, covered)).toFixed(3);

  return {
    aabb: { minX, maxX, minY, maxY, minZ, maxZ },
    coverage: covered / (GRID * GRID),
    underpassFrac: underpass / Math.max(1, covered),
    topMedian, topMin, topMax,
    gradient: { gx, gz }, planeP0: p0, planeRms: rms,
    edges, materials: matFracs,
  };
}

function solve3(A, B) {
  const m = A.map((row, i) => [...row, B[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

// ── classification ──────────────────────────────────────────────────────────

function classify(a) {
  const waterFrac = a.materials["Water"] ?? 0;
  const grad = Math.hypot(a.gradient.gx, a.gradient.gz);
  const planar = a.planeRms <= PLANE_RMS_MAX;
  const nEdges = Object.values(a.edges).filter(Boolean).length;

  if (a.underpassFrac >= BRIDGE_COLUMN_FRAC) {
    return { kind: "bridge", category: "Bridges", physics: "approx" };
  }
  if (waterFrac >= 0.5) {
    return { kind: "water", category: "Water", physics: "approx" };
  }
  if (planar && grad <= FLAT_GRADIENT_MAX) {
    // Flat — split by road connectivity, then by dominant ground material.
    if (nEdges >= 3) return { kind: "flat", category: "Roads: Cross & T", physics: "exact" };
    if (nEdges === 2) {
      const straight = (a.edges.px && a.edges.nx) || (a.edges.pz && a.edges.nz);
      return { kind: "flat", category: straight ? "Roads: Straight" : "Roads: Corner", physics: "exact" };
    }
    if (nEdges === 1) return { kind: "flat", category: "Roads: End & Detail", physics: "exact" };
    const grass = (a.materials["Grass"] ?? 0) + (a.materials["Sand"] ?? 0) + (a.materials["Alternate_Dirt"] ?? 0) + (a.materials["Stone"] ?? 0);
    return { kind: "flat", category: grass >= 0.4 ? "Ground" : "Roads: End & Detail", physics: "exact" };
  }
  if (planar && grad > FLAT_GRADIENT_MAX) {
    const ax = Math.abs(a.gradient.gx), az = Math.abs(a.gradient.gz);
    const dominance = Math.max(ax, az) / (ax + az);
    if (dominance >= AXIS_DOMINANCE) {
      return { kind: "slope", category: "Slopes", physics: "exact" };
    }
    return { kind: "slope-diagonal", category: "Slopes: Curved & Corner", physics: "approx" };
  }
  // Non-planar top: curved slope transitions, humps, decor-heavy tiles.
  if (grad > FLAT_GRADIENT_MAX && a.topMax - a.topMin > 0.3) {
    return { kind: "slope-curved", category: "Slopes: Curved & Corner", physics: "approx" };
  }
  return { kind: "misc", category: "Misc", physics: "approx" };
}

const DIR_LABEL = { px: "+X", nx: "−X", pz: "+Z", nz: "−Z" };

function slopeDir(gradient) {
  const { gx, gz } = gradient;
  if (Math.abs(gx) >= Math.abs(gz)) return gx >= 0 ? "px" : "nx";
  return gz >= 0 ? "pz" : "nz";
}

function makeLabel(num, cls, a) {
  const grass = (a.materials["Grass"] ?? 0) >= 0.25 ? " grass" : "";
  switch (cls.kind) {
    case "water": return `${num} Water`;
    case "bridge": return `${num} Bridge`;
    case "slope": {
      const rise = (a.topMax - a.topMin).toFixed(1);
      return `${num} Slope ${DIR_LABEL[slopeDir(a.gradient)]} rise ${rise}${grass}`;
    }
    case "slope-diagonal": return `${num} Slope diag${grass}`;
    case "slope-curved": return `${num} Slope curved${grass}`;
    case "flat": {
      const n = Object.entries(a.edges).filter(([, v]) => v).map(([k]) => DIR_LABEL[k]).join("");
      const conn = n ? ` road ${n}` : "";
      const h = a.topMedian.toFixed(2);
      return `${num}${conn}${grass} h${h}`;
    }
    default: return `${num} Misc${grass}`;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const files = fs.readdirSync(ASSETS_DIR).filter(f => f.endsWith(".gltf")).sort();
const catalog = {};
const counts = new Map();
const t0 = Date.now();
for (const file of files) {
  const name = file.replace(/\.gltf$/, "");
  const gltf = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, file), "utf8"));
  const buffers = decodeBuffers(gltf);
  const tris = readTriangles(gltf, buffers);
  const a = analyzeTile(tris);
  const cls = classify(a);
  const num = name.replace("roadTile_", "");
  const entry = {
    kind: cls.kind,
    category: cls.category,
    physics: cls.physics,
    label: makeLabel(num, cls, a),
    size: [
      +(a.aabb.maxX - a.aabb.minX).toFixed(3),
      +(a.aabb.maxY - a.aabb.minY).toFixed(3),
      +(a.aabb.maxZ - a.aabb.minZ).toFixed(3),
    ],
    topMedian: +a.topMedian.toFixed(3),
    topMin: +a.topMin.toFixed(3),
    topMax: +a.topMax.toFixed(3),
    minY: +a.aabb.minY.toFixed(3),
    edges: Object.entries(a.edges).filter(([, v]) => v).map(([k]) => k),
    materials: a.materials,
    underpassFrac: +a.underpassFrac.toFixed(3),
  };
  if (cls.kind === "slope") {
    // Normalized ascent direction + rise for shared/heightfield.ts. Gradient
    // points uphill already (y = p0 + g·x): ascent = sign of dominant axis.
    // base/rise come from the fitted plane EXTRAPOLATED to the tile edges —
    // column samples sit half a grid step inside the tile, so raw
    // topMin/topMax under-measure the rise by ~2·gradient·step/2 (≈4cm on a
    // full-rise tile), which would leave a visible physics lip where the
    // slope meets its neighbouring flat tile.
    const dir = slopeDir(a.gradient);
    const alongX = dir === "px" || dir === "nx";
    const g = alongX ? a.gradient.gx : a.gradient.gz;
    const lo = alongX ? a.aabb.minX : a.aabb.minZ;
    const hi = alongX ? a.aabb.maxX : a.aabb.maxZ;
    const span = hi - lo;
    // Plane value at the LOW edge, other axis held at tile center.
    const cx = (a.aabb.minX + a.aabb.maxX) / 2, cz = (a.aabb.minZ + a.aabb.maxZ) / 2;
    const lowCoord = g >= 0 ? lo : hi;
    const base = alongX
      ? a.planeP0 + a.gradient.gx * lowCoord + a.gradient.gz * cz
      : a.planeP0 + a.gradient.gx * cx + a.gradient.gz * lowCoord;
    entry.slope = {
      ax: dir === "px" ? 1 : dir === "nx" ? -1 : 0,
      az: dir === "pz" ? 1 : dir === "nz" ? -1 : 0,
      base: +base.toFixed(3),
      rise: +(Math.abs(g) * span).toFixed(3),
    };
  }
  catalog[name] = entry;
  counts.set(cls.category, (counts.get(cls.category) ?? 0) + 1);
}

fs.writeFileSync(OUT_JSON, JSON.stringify(catalog, null, 1));
console.log(`Baked ${files.length} tiles in ${Date.now() - t0}ms → ${path.relative(process.cwd(), OUT_JSON)}`);
for (const [cat, n] of [...counts.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${cat.padEnd(28)} ${n}`);
}

// Markdown catalog for humans — one table per category.
const byCat = new Map();
for (const [name, e] of Object.entries(catalog)) {
  if (!byCat.has(e.category)) byCat.set(e.category, []);
  byCat.get(e.category).push([name, e]);
}
let md = `# Kenney 3D Road Tiles — baked catalog\n\nGenerated by \`web-slice/tools/bake-road-tiles.mjs\` — do not edit by hand.\nTiles are 3×3m in plan (pivot at a corner in the source files; the loader recenters XZ).\n\`physics: exact\` = the column heightfield represents this tile faithfully (flat or straight axis slope).\n\`physics: approx\` = visual-only for now: the tile renders but physics treats it as FLAT at its median top height (bridges can't be driven under yet — column model has one height per column).\n\n`;
for (const [cat, entries] of [...byCat.entries()].sort()) {
  md += `## ${cat} (${entries.length})\n\n| tile | label | kind | physics | top median | rise | road edges | materials |\n|---|---|---|---|---|---|---|---|\n`;
  for (const [name, e] of entries) {
    const mats = Object.entries(e.materials).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([m, f]) => `${m} ${(f * 100).toFixed(0)}%`).join(", ");
    md += `| ${name} | ${e.label} | ${e.kind} | ${e.physics} | ${e.topMedian} | ${(e.topMax - e.topMin).toFixed(2)} | ${e.edges.join(",") || "—"} | ${mats} |\n`;
  }
  md += "\n";
}
fs.writeFileSync(OUT_MD, md);
console.log(`Wrote ${path.relative(process.cwd(), OUT_MD)}`);
