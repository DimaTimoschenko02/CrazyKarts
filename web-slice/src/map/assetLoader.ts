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

const ASSET_BASE = "/assets/space-kit/";

export type AssetLibrary = ReadonlyMap<string, THREE.Group>;

// Procedural (non-GLB) assets built in code rather than loaded from a file.
// The Kenney terrain kit has NO straight vertical wall piece (only slanted
// side/cliff faces), so `wall_block` is a plain box the map author drops to get
// a straight, grid-aligned solid wall. Its collision comes from the same
// heightfield "wall cell" path as terrain_sideCliff (see isWallOnlyAsset in
// shared/heightfield.ts — a wall_block cell contributes no height → sample()
// returns null → kart.ts step 8 treats it as solid).
const PROCEDURAL_ASSETS = new Set<string>(["wall_block"]);

// A wall block is 1×1 in plan (exactly one grid cell) and this tall in world
// units — ~a two-level plateau, so a single placed block reads clearly as a
// wall the kart can't see over. Its bottom sits on the cell's y_level (place()
// sets the group Y); the top is at +WALL_BLOCK_HEIGHT above that.
const WALL_BLOCK_HEIGHT = 1.0;

function buildWallBlock(lib: Map<string, THREE.Group>): THREE.Group {
  const geom = new THREE.BoxGeometry(1, WALL_BLOCK_HEIGHT, 1);
  // Reuse the terrain tile's material so the wall matches the map's look;
  // fall back to a mars-terrain colour if terrain isn't in this library.
  let sampled: THREE.Material | undefined;
  lib.get("terrain")?.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!sampled && mesh.isMesh) sampled = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  });
  const mat = sampled ? sampled.clone() : new THREE.MeshStandardMaterial({ color: 0x9c5a3c, roughness: 0.9 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = WALL_BLOCK_HEIGHT / 2; // box is centred → drop its bottom onto y=0
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

function recenterXZ(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  for (const child of root.children) {
    child.position.x -= center.x;
    child.position.z -= center.z;
  }
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
      recenterXZ(gltf.scene);
      lib.set(name, gltf.scene);
    })
  );
  // Build procedural assets AFTER the GLBs so they can reuse loaded materials
  // (e.g. wall_block borrows the terrain tile's material).
  for (const name of names) {
    if (name === "wall_block") lib.set(name, buildWallBlock(lib));
  }
  return lib;
}

// Kart model: recentered on XZ like tiles, then additionally floored (bottom
// of the AABB moved to y=0) and uniformly scaled to the requested length
// along Z, so it drops into the physics rig regardless of authored size.
export async function loadKartModel(name: string, targetLength: number): Promise<THREE.Group> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ASSET_BASE + name + ".glb");
  const root = gltf.scene;
  recenterXZ(root);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const scale = targetLength / Math.max(size.z, 1e-3);
  const wrapper = new THREE.Group();
  wrapper.add(root);
  root.position.y = -box.min.y;
  wrapper.scale.setScalar(scale);
  return wrapper;
}
