#!/usr/bin/env node
// Bakes XZ collision shapes (structural OBB half-extents / natural-decor
// convex hulls) from the raw Kenney Space Kit GLBs into a committed JSON
// table (shared/collisionShapes.json) — see design/notes/collision-v2.md §5.
//
// WHY A MANUAL GLB PARSER, NOT three.js GLTFLoader: GLTFLoader needs
// browser-only globals (fetch of relative asset URLs, Image/canvas texture
// decode, etc.) that don't exist in a plain Node script, and pulling in a
// headless-DOM shim just to read POSITION accessors would be a lot of
// dependency weight for ~15 one-shot asset reads. glTF's binary container
// (.glb) is a tiny, fully-documented format (12-byte header + JSON chunk +
// BIN chunk) — reading node transforms + POSITION accessors directly off the
// buffer is ~150 lines with zero dependencies, and this script runs to a
// COMMITTED artifact (not part of the runtime bundle), so a bit of manual
// parsing here is a fair trade against adding a texture and material stack
// we would never touch.
//
// Run: node tools/bake-collision-shapes.mjs
// Output: src/shared/collisionShapes.json (committed)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, "../public/assets/space-kit");
const OUT_PATH = path.join(__dirname, "../src/shared/collisionShapes.json");

// Keep in sync with src/shared/staticColliders.ts's STRUCTURAL_PROP_ASSETS /
// NATURAL_DECOR_ASSETS sets (that module is the runtime source of truth for
// WHICH assets get a collider at all and the size/height gates; this script
// only needs to know which asset family to bake as OBB vs. hull). Assets not
// listed here simply have no entry in the output table — buildStaticColliders
// skips props with no matching table entry regardless of family, same as it
// already skips anything outside both sets today.
const STRUCTURAL_ASSETS = [
  "corridor", "corridor_corner", "corridor_cornerRound", "corridor_cornerRoundWindow",
  "corridor_cross", "corridor_detailed", "corridor_end", "corridor_open", "corridor_roof",
  "corridor_split", "corridor_wall", "corridor_wallCorner", "corridor_window", "corridor_windowClosed",
  "hangar_largeA", "hangar_largeB", "hangar_roundA", "hangar_roundB", "hangar_roundGlass",
  "hangar_smallA", "hangar_smallB",
  "structure", "structure_closed", "structure_detailed", "structure_diagonal",
  "gate_complex", "gate_simple",
  "craft_cargoA", "craft_cargoB", "craft_miner",
  "craft_speederA", "craft_speederB", "craft_speederC", "craft_speederD",
  "rocket_baseA", "rocket_baseB", "rocket_finsA", "rocket_finsB",
  "rocket_fuelA", "rocket_fuelB", "rocket_sidesA", "rocket_sidesB",
  "rocket_topA", "rocket_topB",
  "machine_barrel", "machine_barrelLarge", "machine_generator", "machine_generatorLarge",
  "satelliteDish_large", "turret_single", "turret_double",
  "rover",
];
const NATURAL_DECOR_ASSETS = [
  "rock", "rocks_smallA", "rocks_smallB", "rock_crystals",
  "rock_largeA", "rock_largeB", "rock_crystalsLargeA", "rock_crystalsLargeB",
  "meteor", "meteor_detailed", "meteor_half",
  "crater", "craterLarge", "bones",
];

// Max hull vertex count after simplification (collision-v2.md §5: "упростить
// до ≤8 вершин").
const MAX_HULL_VERTS = 8;

// Mirrors src/map/assetLoader.ts's PIVOT_RECENTER_ASSETS + the pack's shared
// staging-pivot node translation (verified identical — (2, 0, 1.5) — across
// all 153 Kenney Space Kit .glb files by walking each file's raw node graph;
// see assetLoader.ts's doc comment on findStagedPivot for the full story).
// Everything EXCEPT this allowlist keeps the original AABB-center recenter
// below (unchanged, still correct for symmetric tiles) — corridor_wall is a
// thin panel authored flush against one edge of its staging cell, so its own
// AABB center is NOT the pack's true pivot, and using it (as every other
// asset safely can) shifts the wall ~0.45m off the edge it's meant to hug.
// If you add another asset to assetLoader.ts's PIVOT_RECENTER_ASSETS, add it
// here too and rerun this script (`node tools/bake-collision-shapes.mjs`).
const PIVOT_RECENTER_ASSETS = new Set(["corridor_wall"]);
const STAGED_PIVOT = { x: 2, z: 1.5 };

// ─── Minimal glTF-binary (.glb) reader ──────────────────────────────────────

function readGlb(filePath) {
  const buf = readFileSync(filePath);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`${filePath}: not a glb (bad magic)`);
  const length = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(chunkData.toString("utf8")); // 'JSON'
    else if (chunkType === 0x004e4942) bin = chunkData; // 'BIN\0'
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error(`${filePath}: missing JSON chunk`);
  return { json, bin };
}

const COMPONENT_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// Reads a POSITION (VEC3, FLOAT) accessor into a flat array of {x,y,z}.
function readPositions(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  if (accessor.type !== "VEC3" || accessor.componentType !== 5126) {
    throw new Error(`accessor ${accessorIndex}: expected VEC3/FLOAT, got ${accessor.type}/${accessor.componentType}`);
  }
  const view = gltf.bufferViews[accessor.bufferView];
  const compSize = COMPONENT_SIZE[accessor.componentType];
  const numComponents = TYPE_COMPONENTS[accessor.type];
  const stride = view.byteStride ?? compSize * numComponents;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    const o = base + i * stride;
    out.push({
      x: bin.readFloatLE(o),
      y: bin.readFloatLE(o + 4),
      z: bin.readFloatLE(o + 8),
    });
  }
  return out;
}

// 4x4 column-major matrix helpers (glTF convention) — just enough TRS
// composition to walk a shallow node tree (these assets are 1-2 levels deep,
// see rock_largeA.glb's tmpParent->mesh-node shape confirmed while writing
// this script).
function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mat4Multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
function mat4FromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return mat4FromTRS(t, q, s);
}
function transformPoint(m, p) {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}

// Walks the scene graph, returning every mesh-instance vertex transformed
// into the file's own root space (world space within this single-asset GLB).
function collectWorldVertices(gltf, bin) {
  const sceneIndex = gltf.scene ?? 0;
  const roots = gltf.scenes[sceneIndex].nodes;
  const points = [];
  const walk = (nodeIndex, parentMatrix) => {
    const node = gltf.nodes[nodeIndex];
    const world = mat4Multiply(parentMatrix, nodeLocalMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      for (const prim of mesh.primitives) {
        const posIdx = prim.attributes.POSITION;
        if (posIdx === undefined) continue;
        for (const p of readPositions(gltf, bin, posIdx)) points.push(transformPoint(world, p));
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const r of roots) walk(r, mat4Identity());
  return points;
}

// ─── XZ convex hull (Andrew's monotone chain) ───────────────────────────────

function cross(o, a, b) {
  return (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
}

function convexHullXZ(points) {
  // Dedupe near-identical points first — decor meshes have plenty of
  // coincident verts (shared edges across triangles) that would otherwise
  // just slow the sort/scan down for no benefit.
  const seen = new Set();
  const pts = [];
  for (const p of points) {
    const key = `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push({ x: p.x, z: p.z });
  }
  pts.sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
  if (pts.length < 3) return pts;

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper); // CCW
}

// Visvalingam-Whyatt-style simplification: repeatedly drop the vertex whose
// removal changes the hull's enclosed area the least, until <= MAX_HULL_VERTS
// remain. Keeps the hull CONSERVATIVE-ish (not strictly outward-only, but the
// smallest-area-delta choice biases toward barely-detectable corners first,
// which is exactly the "round off tiny extra facets" behavior we want for a
// ~10-30 vertex rock hull collapsing to <=8).
function simplifyHull(hull, maxVerts) {
  const verts = hull.slice();
  const triArea = (a, b, c) => Math.abs(cross(a, b, c)) / 2;
  while (verts.length > maxVerts) {
    let bestIdx = -1;
    let bestArea = Infinity;
    const n = verts.length;
    for (let i = 0; i < n; i++) {
      const a = verts[(i - 1 + n) % n];
      const b = verts[i];
      const c = verts[(i + 1) % n];
      const area = triArea(a, b, c);
      if (area < bestArea) {
        bestArea = area;
        bestIdx = i;
      }
    }
    verts.splice(bestIdx, 1);
  }
  return verts;
}

// ─── Bake one asset ──────────────────────────────────────────────────────────

function bakeAsset(name, kind) {
  const filePath = path.join(ASSET_DIR, `${name}.glb`);
  const { json, bin } = readGlb(filePath);
  const worldVerts = collectWorldVertices(json, bin);
  if (worldVerts.length === 0) throw new Error(`${name}: no POSITION data found`);

  // Recenter XZ exactly like assetLoader.ts's runtime recenterXZ() does:
  // AABB CENTER (min+max)/2, not vertex centroid — must match so the baked
  // local-space shape lines up with what the renderer actually places at
  // world (x,z) at runtime.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const p of worldVerts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const heightY = maxY - minY;

  if (kind === "obb") {
    const shape = {
      type: "obb",
      halfX: (maxX - minX) / 2,
      halfZ: (maxZ - minZ) / 2,
      // Top of the mesh's own AABB, in the SAME raw (un-Y-recentered) local
      // space assetLoader.ts places props in — see its "Y is left untouched"
      // doc comment. shared/staticColliders.ts turns this into a world-space
      // Y ceiling (worldTopY) so server/weapons/projectileSweep.ts can let a
      // projectile flying ABOVE a building/rock pass over it instead of
      // hitting an invisible floor-to-ceiling column (2026-07-10 owner
      // review: "динамит, перелетающий камень по высокой дуге, прилипнет в
      // воздухе над ним").
      topY: round4(maxY),
    };
    // See PIVOT_RECENTER_ASSETS doc comment above — for these few assets the
    // box's own center sits away from the pack's shared pivot (where
    // assetLoader.ts actually recenters the rendered mesh), so the baked
    // collider needs an explicit local offset to stay aligned with it.
    if (PIVOT_RECENTER_ASSETS.has(name)) {
      shape.centerX = round4(centerX - STAGED_PIVOT.x);
      shape.centerZ = round4(centerZ - STAGED_PIVOT.z);
    }
    return shape;
  }

  // Natural decor: XZ convex hull of the recentered points.
  const recentered = worldVerts.map(p => ({ x: p.x - centerX, z: p.z - centerZ }));
  let hull = convexHullXZ(recentered);
  if (hull.length > MAX_HULL_VERTS) hull = simplifyHull(hull, MAX_HULL_VERTS);
  return {
    type: "hull",
    verts: hull.map(v => [round4(v.x), round4(v.z)]),
    heightY: round4(heightY),
    topY: round4(maxY), // see the "obb" branch's topY doc comment above
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const table = {};
const report = [];
for (const name of STRUCTURAL_ASSETS) {
  try {
    table[name] = bakeAsset(name, "obb");
    report.push(`OBB  ${name}: halfX=${table[name].halfX} halfZ=${table[name].halfZ}`);
  } catch (e) {
    console.warn(`[bake] skipping structural "${name}": ${e.message}`);
  }
}
for (const name of NATURAL_DECOR_ASSETS) {
  try {
    table[name] = bakeAsset(name, "hull");
    report.push(`HULL ${name}: ${table[name].verts.length} verts, heightY=${table[name].heightY}`);
  } catch (e) {
    console.warn(`[bake] skipping natural-decor "${name}": ${e.message}`);
  }
}

writeFileSync(OUT_PATH, JSON.stringify(table, null, 2) + "\n");
console.log(report.join("\n"));
console.log(`\n[bake] wrote ${Object.keys(table).length} shapes -> ${path.relative(process.cwd(), OUT_PATH)}`);
