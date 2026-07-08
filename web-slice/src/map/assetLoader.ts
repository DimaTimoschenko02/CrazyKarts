// Space Kit GLB loading with pivot repair.
//
// The Kenney Space Kit GLBs were exported from one big Blender scene, so raw
// vertices sit far from the local origin (typical offset ~(2.0, _, 1.5) from
// the visual center). Godot fixes this once at import time with an
// EditorScenePostImport hook (tools/recenter_on_import.gd); three.js loads
// the raw file, so we apply the exact same repair at load time: shift the
// content so its AABB center lands on x=0, z=0. Y is left untouched — tile
// pivots must stay on the authored ground plane (terrain top at y=0,
// terrain_side spanning y in [-0.5, 0]), matching the map grid math.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const ASSET_BASE = "/assets/space-kit/";

// Kart/car bodies live in a separate Kenney pack ("Blocky Cars"), not the
// terrain space-kit — the old craft_racer.glb (space-kit) scaled to a 1x1m
// tile read as visibly too wide for a single map lane, see kart/stats.ts.
// Every model in this pack shares one external "Textures/colormap.png" (NOT
// embedded in the .glb despite the extension — Kenney kept a relative image
// URI even inside the binary container), so the folder layout under public/
// must keep that relative Textures/ subfolder alongside the .glb files for
// GLTFLoader to resolve it.
const CAR_ASSET_BASE = "/assets/cars/";

// This car pack's own local +Z is each model's FRONT (confirmed by reading
// wheel-front-*/wheel-back-* node translations straight out of the glTF JSON
// for race.glb, sedan.glb, police.glb, kart-oobi.glb — front wheels always
// sit at positive Z). kart.ts's forward convention is the opposite: nose at
// -Z (see kart.ts forwardOf()). Rotate every loaded car model 180° around Y
// once at load time so "front wheel" lines up with the engine's forward axis
// — this is a property of the WHOLE pack (verified across 4 different
// models), not a one-off fix for the current default kart.
const CAR_FRONT_IS_PLUS_Z = true;

export type AssetLibrary = ReadonlyMap<string, THREE.Group>;

// Procedural (non-GLB) assets built in code rather than loaded from a file.
// The Kenney terrain kit has NO straight vertical wall piece (only slanted
// side/cliff faces), so the wall_block family are boxes the map author drops
// to get straight, grid-aligned walls/fences. Since the 2026-07-08 owner
// decision ALL four cubes share the same physics (heightCellFor's cube
// branch in shared/heightfield.ts): the top face is walkable, the sides
// block because a full-level 0.5 step exceeds MAX_STEP. wall_block* and
// ground_block now differ only visually (top-edge fillets); ground_block is
// kept as a plain-cube alias so existing maps keep loading.
const PROCEDURAL_ASSETS = new Set<string>(["wall_block", "wall_block_round", "wall_block_corner", "ground_block"]);

// A wall block is 1×1 in plan (exactly one grid cell). LEVEL_HEIGHT is 0.5m
// (see .claude/rules/map-building.md) — a single block is exactly one level,
// so the map author stacks blocks (Q/E in the editor) to build taller walls
// instead of one block reading as "two levels tall" on its own. Its bottom
// sits on the cell's y_level (place() sets the group Y); the top is at
// +WALL_BLOCK_HEIGHT above that.
const WALL_BLOCK_HEIGHT = 0.5;

// Fillet radius for the rounded/corner wall variants — deliberately small
// ("chuть-чуть", per the design ask) so the block still reads as a mostly-
// straight wall with just a softened edge, not a visibly bevelled column.
const WALL_FILLET_RADIUS = 0.12;
// Radial segments used for BOTH the quarter-cylinder edge fillets and the
// corner sphere octant — 10 is enough to look smooth at a 0.12m radius
// without adding a meaningful triangle count to a per-cell wall piece.
const WALL_FILLET_SEGMENTS = 10;

// Samples the terrain tile's own material so every procedural wall variant
// matches the map's look; falls back to a mars-terrain colour if terrain
// isn't in this library (e.g. a diagnostic scene that never loaded it).
function wallMaterial(lib: Map<string, THREE.Group>): THREE.Material {
  let sampled: THREE.Material | undefined;
  lib.get("terrain")?.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!sampled && mesh.isMesh) sampled = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  });
  return sampled ? sampled.clone() : new THREE.MeshStandardMaterial({ color: 0x9c5a3c, roughness: 0.9 });
}

function finishWallMesh(geom: THREE.BufferGeometry, mat: THREE.Material): THREE.Group {
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// A box spanning explicit world-space min/max on each axis (rather than the
// usual BoxGeometry "size + you center it yourself" API) — every fillet piece
// below is defined by its span, so building them this way keeps the geometry
// math exactly matching the derivation in the surrounding comments (no silent
// off-by-half errors from re-deriving center-from-size at each call site).
function boxSpan(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  geom.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return geom;
}

// A convex quarter-round "pie slice" solid — the piece that fills the gap
// left when a box's sharp top edge (where the top face meets one vertical
// face) is filleted away. Built from CylinderGeometry's default Y-axis
// cylinder (cross-section in X-Z at each Y), swept over a 90° wedge
// (thetaStart=π, thetaLength=π/2) and then reoriented so its "length" runs
// along the requested world axis:
//   axis "x": rotateZ(-90°) swings the cylinder's Y-axis onto +X. Cross
//     section ends up in (Y,Z), sweeping from (Δy=+r,Δz=0) [tangent to the
//     top face] to (Δy=0,Δz=-r) [tangent to the -Z face] — i.e. it rounds
//     the top/-Z edge, oriented so rot=0 in the editor faces the fillet -Z
//     (matching the "nose at -Z" convention other assets use).
//   axis "z": rotateX(+90°) swings the cylinder's Y-axis onto +Z. Cross
//     section ends up in (X,Y), sweeping from (Δx=-r,Δy=0) [tangent to the
//     -X face] to (Δx=0,Δy=+r) [tangent to the top face] — rounds the
//     top/-X edge.
// Both the cylinder's own curved side (the visible rounded surface) and its
// two thetaLength-boundary "cheek" faces are supplied automatically or by
// adjacent box pieces (see the callers) — the shape is only ever assembled
// abutting boxes whose faces exactly close those open cheeks, so the merged
// solid stays watertight without extra manual cap geometry.
function quarterFillet(radius: number, length: number, axis: "x" | "z"): THREE.BufferGeometry {
  const geom = new THREE.CylinderGeometry(radius, radius, length, WALL_FILLET_SEGMENTS, 1, false, Math.PI, Math.PI / 2);
  if (axis === "x") geom.rotateZ(-Math.PI / 2);
  else geom.rotateX(Math.PI / 2);
  return geom;
}

// wall_block: plain straight box, no rounding — the baseline solid wall.
function buildWallBlock(mat: THREE.Material): THREE.Group {
  const geom = boxSpan(-0.5, 0.5, 0, WALL_BLOCK_HEIGHT, -0.5, 0.5);
  return finishWallMesh(geom, mat);
}

// wall_block_round: ONE top edge rounded — the top/-Z edge at rot=0 (rotating
// the placed instance with R aims the rounded side at any of the 4 cardinal
// directions, same as every other rotatable tile). Assembled from 3 convex
// pieces that exactly partition the box (see quarterFillet's doc comment for
// why the seams are invisible):
//   back      — the majority of the block, away from the rounded edge, full
//               height, z ∈ [-0.5+r, 0.5].
//   frontLow  — the -Z strip BELOW the fillet, height ∈ [0, h-r].
//   fillet    — the quarter-round replacing the strip's sharp top corner.
function buildWallBlockRound(mat: THREE.Material): THREE.Group {
  const h = WALL_BLOCK_HEIGHT;
  const r = WALL_FILLET_RADIUS;
  const back = boxSpan(-0.5, 0.5, 0, h, -0.5 + r, 0.5);
  const frontLow = boxSpan(-0.5, 0.5, 0, h - r, -0.5, -0.5 + r);
  const fillet = quarterFillet(r, 1, "x");
  fillet.translate(0, h - r, -0.5 + r);
  const merged = mergeGeometries([back, frontLow, fillet], false)!;
  return finishWallMesh(merged, mat);
}

// wall_block_corner: TWO adjacent top edges rounded — the top/-Z edge AND the
// top/-X edge at rot=0, meeting at the -X-Z corner — for fence corner pieces
// (pair with wall_block_round along a straight run, cap the turn with this).
// The block is partitioned into 3 non-overlapping regions (see the module
// doc comment on quarterFillet for the per-edge fillet derivation):
//   region A (x ≥ -0.5+r)              — a narrower copy of wall_block_round's
//                                         own 3-piece decomposition (backA /
//                                         frontLowA / filletA).
//   region B (x < -0.5+r, z ≥ -0.5+r)  — the mirror-image decomposition for
//                                         the -X edge (leftLowB / filletB),
//                                         which needs no "back" piece of its
//                                         own since its whole x-span IS the
//                                         fillet's notch depth.
//   corner   (x < -0.5+r, z < -0.5+r)  — cornerLower below the fillet band,
//                                         and a smooth octant-sphere patch
//                                         above it (radius r, centered on the
//                                         same point both edge fillets curve
//                                         toward) instead of letting the two
//                                         cylindrical fillets cross in a hard
//                                         crease — this is the "аккуратный
//                                         блендом" the corner piece needs.
// The octant sphere is C0-continuous with filletA/filletB exactly at their
// shared boundary planes (x=-0.5+r and z=-0.5+r) because a sphere's cross-
// section AT its own center plane is a full circle of the sphere's radius —
// identical to the constant-radius cylinder cross-section there. Away from
// those planes the sphere's radius tapers smoothly toward the corner point,
// giving a true 3D rounded-corner look rather than an extruded ridge. Note:
// the extreme corner itself (the tiny sliver between the sphere's inscribed
// quarter-disk and the box's literal (x=-0.5,z=-0.5) corner point, at
// y=h-r) is closed by cornerLower's flat top rather than more curvature — a
// sub-r/2-scale micro-facet, not a visible seam or a rendering hole.
function buildWallBlockCorner(mat: THREE.Material): THREE.Group {
  const h = WALL_BLOCK_HEIGHT;
  const r = WALL_FILLET_RADIUS;

  // Region A: x ∈ [-0.5+r, 0.5] — same shape as wall_block_round, narrowed.
  const backA = boxSpan(-0.5 + r, 0.5, 0, h, -0.5 + r, 0.5);
  const frontLowA = boxSpan(-0.5 + r, 0.5, 0, h - r, -0.5, -0.5 + r);
  const filletA = quarterFillet(r, 1 - r, "x");
  filletA.translate((-0.5 + r + 0.5) / 2, h - r, -0.5 + r);

  // Region B: x ∈ [-0.5, -0.5+r], z ∈ [-0.5+r, 0.5] — mirror decomposition
  // for the -X edge; no "back" piece (its x-span IS the notch depth).
  const leftLowB = boxSpan(-0.5, -0.5 + r, 0, h - r, -0.5 + r, 0.5);
  const filletB = quarterFillet(r, 1 - r, "z");
  filletB.translate(-0.5 + r, h - r, (-0.5 + r + 0.5) / 2);

  // Corner: x ∈ [-0.5, -0.5+r], z ∈ [-0.5, -0.5+r] — plain box below the
  // fillet band, octant sphere blend above it.
  const cornerLower = boxSpan(-0.5, -0.5 + r, 0, h - r, -0.5, -0.5 + r);
  // phi ∈ [-π/2, 0] selects Δx≤0 & Δz≤0; theta ∈ [0, π/2] selects Δy≥0 — the
  // single octant that faces "up and into the corner" (see doc comment above
  // for why this exactly meets filletA/filletB at their shared planes).
  const sphereSegs = Math.max(2, Math.ceil(WALL_FILLET_SEGMENTS / 2));
  const cornerBlend = new THREE.SphereGeometry(r, WALL_FILLET_SEGMENTS, sphereSegs, -Math.PI / 2, Math.PI / 2, 0, Math.PI / 2);
  cornerBlend.translate(-0.5 + r, h - r, -0.5 + r);

  const merged = mergeGeometries(
    [backA, frontLowA, filletA, leftLowB, filletB, cornerLower, cornerBlend],
    false
  )!;
  return finishWallMesh(merged, mat);
}

function recenterXZ(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  for (const child of root.children) {
    child.position.x -= center.x;
    child.position.z -= center.z;
  }
}

// ROOT CAUSE of "corridor_wall doesn't stitch to corridor_wallCorner / floor
// tiles" (map_v2.json, reported as thin tall wall panels not meeting at the
// joint): recenterXZ() above APPROXIMATES the pack's shared authoring pivot
// by recomputing each asset's own AABB center. That only reproduces the true
// pivot when an asset's visible geometry happens to be symmetric about it —
// true for full square tiles (terrain, corridor, wall_block*), false for a
// piece deliberately mounted flush against ONE edge of its staging cell.
// Read every Space Kit .glb's raw node graph directly (see
// tools/ scratch analysis, not committed — re-derivable with the same glTF
// node-walk bake-collision-shapes.mjs already uses) and every one of the
// 153 assets shares an identical node chain: sceneRoot -> "tmpParent" ->
// <assetName> node, and that innermost node's local translation is (2, 0,
// 1.5) in EVERY file, no exceptions — the whole pack was built in one
// shared Blender "staging cell" and exported piece by piece without ever
// moving that cell. That translation IS the intended pivot; reading it
// directly is exact even when the visible mesh isn't centered on it.
//
// corridor_wall's raw AABB is X∈[2.4,2.5] (a 0.1m-thick panel flush against
// the +X edge of its staging cell), Z∈[1.0,2.0] (full height, symmetric).
// AABB-center recenter computes center=(2.45,1.5) — only 0.05m off the true
// pivot in X, but that's still enough to visually "unmount" the wall from
// the cell edge; after subtracting pivot(2,1.5) instead the panel sits at
// local X∈[0.4,0.5] (flush on the edge, as authored) instead of
// X∈[-0.05,0.05] (floating near the cell's dead center). Confirmed against
// map_v2.json's 8 corridor_wall placements + 2 corridor_wallCorner corners:
// corridor_wallCorner's own AABB is already symmetric about (2,1.5) (0 delta)
// so it needs no change — only corridor_wall itself was off.
//
// NOT applied pack-wide: most other Space Kit assets ALSO have an AABB
// center that differs from this same (2,1.5) pivot (e.g. terrain_sideCorner,
// terrain_roadCorner, terrain_sideCliff, rail*, pipe_corner*, stairs*,
// monorail_trackCorner*) — but those are the exact assets
// .claude/rules/map-building.md documents as empirically verified/calibrated
// (rot→direction tables built and screenshot-checked against the CURRENT
// AABB-center placement) and are already placed across every shipped map
// (arena_slice, mars_base, map_v1/v2, current-map_v1). Switching their
// recenter method would silently shift every one of those already-tuned
// placements. This fix is intentionally scoped to the one asset that is
// both provably mis-centered AND actually in use (map_v2.json) — anything
// else needing the same fix later should go through the same diagnose-first
// workflow the map-building rules already mandate, not get swept in here.
const PIVOT_RECENTER_ASSETS = new Set<string>(["corridor_wall"]);

// Walks down through single-child wrapper nodes (mirrors every Space Kit
// .glb's sceneRoot -> tmpParent -> <assetName> chain) and returns the local
// x/z of the first node that either carries a mesh or has more than one
// child of its own (the point where the shared "tmpParent" wrapping ends
// and the pack's per-asset staging-pivot node begins). Returns null if the
// hierarchy doesn't match that shape — callers fall back to recenterXZ in
// that case rather than mis-centering on some unrelated node's position.
function findStagedPivot(root: THREE.Object3D): { x: number; z: number } | null {
  let node: THREE.Object3D = root;
  while (node.children.length === 1) {
    const child = node.children[0];
    const isMeshNode = (child as THREE.Mesh).isMesh === true;
    if (isMeshNode || child.children.length !== 1) return { x: child.position.x, z: child.position.z };
    node = child;
  }
  return null;
}

function recenterOnStagedPivot(root: THREE.Object3D): void {
  const pivot = findStagedPivot(root);
  if (!pivot) {
    recenterXZ(root); // shape didn't match — safe fallback, not expected to trigger (see doc comment above)
    return;
  }
  for (const child of root.children) {
    child.position.x -= pivot.x;
    child.position.z -= pivot.z;
  }
}

// ROOT CAUSE of the "mirrored wall renders black" bug (and a big chunk of
// the overall scene darkness): every material in this Kenney space-kit glTF
// export has metallicFactor:1, including materials plainly named "rock",
// "bone", "skin" (verified by reading the raw .glb JSON chunk) — clearly an
// unintentional blanket export default, not an authored PBR choice. A fully
// metallic MeshStandardMaterial has ZERO diffuse response (diffuseColor is
// scaled by 1-metalness in the shader) and depends entirely on specular
// reflections from an environment map for anything to show at all — this
// scene has no scene.environment/PMREM, so any face not aimed almost
// exactly at the directional light's reflection angle renders pure black
// regardless of AmbientLight/HemisphereLight intensity.
//
// This is NOT a mirror/winding/normal bug: three.js already auto-corrects
// triangle winding for negative-determinant transforms
// (WebGLRenderer checks `object.matrixWorld.determinantAffine() < 0` and
// flips gl.frontFace accordingly) and normals transform correctly through
// the standard inverse-transpose normal matrix (for a pure X-mirror that's
// exactly diag(-1,1,1) — verified directly against wall_block_round's
// merged BufferGeometry: every normal is non-zero and transforms as
// expected). Two adjacent wall pieces (mirrored or just differently
// rotated) simply face different world directions, so one happens to catch
// the narrow metallic specular glint and the other doesn't — that's what
// read as "the mirrored one is black".
//
// Fix: force metalness to 0 on every space-kit material at load time. Their
// roughnessFactor is already 1 (matte), which is exactly right for this
// low-poly flat-color style — so this makes every asset a normal Lambertian
// diffuse surface that responds to all three scene lights regardless of
// which way it's facing, instead of a black chrome statue except at one
// specific glancing angle. The separate car pack (assets/cars/*) already
// ships metalness:0 (verified) and isn't touched by this.
function neutralizeMetalness(root: THREE.Object3D): void {
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (typeof std.metalness === "number") std.metalness = 0;
    }
  });
}

// Loads the named GLBs (without extension) in parallel and returns templates
// keyed by name. Instances are made with template.clone() — clones share
// geometry and materials, so per-tile cost is one Object3D, not one mesh copy.
export async function loadAssetLibrary(names: readonly string[]): Promise<AssetLibrary> {
  const loader = new GLTFLoader();
  const lib = new Map<string, THREE.Group>();
  await Promise.all(
    names.filter(name => !PROCEDURAL_ASSETS.has(name)).map(async name => {
      const gltf = await loader.loadAsync(ASSET_BASE + name + ".glb");
      if (PIVOT_RECENTER_ASSETS.has(name)) recenterOnStagedPivot(gltf.scene);
      else recenterXZ(gltf.scene);
      neutralizeMetalness(gltf.scene); // see doc comment above — fixes the "black wall" bug
      lib.set(name, gltf.scene);
    })
  );
  // Build procedural assets AFTER the GLBs so they can reuse loaded materials
  // (the wall_block family borrows the terrain tile's material). One shared
  // material instance per library build — cloned once here, not once per
  // wall variant, since Mesh.material is happily shared across meshes.
  if (names.some(name => PROCEDURAL_ASSETS.has(name))) {
    const mat = wallMaterial(lib);
    for (const name of names) {
      if (name === "wall_block") lib.set(name, buildWallBlock(mat));
      else if (name === "wall_block_round") lib.set(name, buildWallBlockRound(mat));
      else if (name === "wall_block_corner") lib.set(name, buildWallBlockCorner(mat));
      else if (name === "ground_block") lib.set(name, buildWallBlock(mat)); // same cube, drivable physics — see PROCEDURAL_ASSETS doc
    }
  }
  return lib;
}

// Kart model: recentered on XZ like tiles, then additionally floored (bottom
// of the AABB moved to y=0), yaw-corrected to the engine's nose-at--Z
// convention (see CAR_FRONT_IS_PLUS_Z above), and uniformly scaled to the
// requested length along Z, so it drops into the physics rig regardless of
// authored size or source pack.
export async function loadKartModel(name: string, targetLength: number): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(CAR_ASSET_BASE + name + ".glb");
  const root = gltf.scene;
  recenterXZ(root);
  if (CAR_FRONT_IS_PLUS_Z) root.rotation.y = Math.PI;
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.z, 1e-3);
  const wrapper = new THREE.Group();
  wrapper.add(root);
  root.position.y = -box.min.y;
  wrapper.scale.setScalar(scale);
  return wrapper;
}
