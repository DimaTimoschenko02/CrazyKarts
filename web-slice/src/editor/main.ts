// Browser map editor for the Kenney Space Kit tile format consumed by
// GameMap (src/map/mapLoader.ts). Standalone page — no game physics, no
// network — just a click-to-place grid tool that exports the same MapJson
// the runtime loader reads (see .claude/rules/map-building.md for the
// asset/rotation conventions this UI surfaces as on-screen hints).
//
// Coordinate convention: the editor works entirely in CELL SPACE (integers
// 0..GRID_SIZE-1, or float sub-cell positions for props). World position is
// derived the same way GameMap does: world = cell - (GRID_SIZE-1)/2. On
// export we emit that same half-offset as origin_offset, so a map made here
// renders identically once loaded through GameMap.fromJson in the game.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadAssetLibrary } from "../map/assetLoader";
import type { AssetLibrary } from "../map/assetLoader";
import type { MapJson } from "../map/mapLoader";
import { TWO_CELL_ASSETS, longAxis } from "../shared/heightfield";
import { shouldDeletePropFirst, topCellYLevelAt } from "./deletePriority";
// Palette data (categories/items/isProp) is shared with the game's preload
// list (src/main.ts) — see shared/mapAssets.ts header comment for why.
import { PALETTE, ASSET_NAMES, isPropAsset, DEFAULT_COLLAPSED_CATEGORIES } from "../shared/mapAssets";

const MIN_GRID_SIZE = 16;
const MAX_GRID_SIZE = 96;
const GRID_SIZE_STEP = 16;
let GRID_SIZE = 32; // cells per side — mutable, see setGridSize()
const TILE_SIZE = 1;
const LEVEL_HEIGHT = 0.5;
let HALF = (GRID_SIZE - 1) / 2; // world offset: world = cell - HALF, kept in sync with GRID_SIZE
const MAX_Y_LEVEL = 6;
const ROT_CYCLE = [0, 90, 180, -90] as const;
const PROP_STEP = 0.25;

// ── DOM scaffolding ──────────────────────────────────────────────────────
const canvasContainer = document.getElementById("canvas-container")!;
const sidebar = document.getElementById("sidebar")!;
const statusMain = document.getElementById("statusMain")!;
const statusHint = document.getElementById("statusHint")!;
const gridSizeInput = document.getElementById("gridSizeInput") as HTMLInputElement;
const btnMapsMenu = document.getElementById("btnMapsMenu") as HTMLButtonElement;
const mapsMenuPanel = document.getElementById("mapsMenuPanel") as HTMLDivElement;
const serverStatus = document.getElementById("serverStatus")!;
const btnUndo = document.getElementById("btnUndo") as HTMLButtonElement;
const btnCenterMap = document.getElementById("btnCenterMap") as HTMLButtonElement;
const mapNameLabel = document.getElementById("mapNameLabel")!;

// ── Scene ──────────────────────────────────────────────────────────────
// Lighting/background kept consistent with the game (src/main.ts) so a map
// built here looks the same once driven — see that file for the numeric
// reasoning (HemisphereLight fill, sun elevation/intensity, palette).
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x23264a);
scene.add(new THREE.HemisphereLight(0x8892cf, 0x6b4a35, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(25, 80, 15);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
camera.position.set(18, 18, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
canvasContainer.appendChild(renderer.domElement);

function resizeRenderer(): void {
  const w = canvasContainer.clientWidth;
  const h = canvasContainer.clientHeight;
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
resizeRenderer();
addEventListener("resize", resizeRenderer);

let grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x00ffee, 0x333366);
scene.add(grid);

// OrbitControls: LEFT/RIGHT mouse are reserved for place/delete, so orbiting
// only happens on middle-drag; panning is disabled to keep the two-button
// place/delete scheme unambiguous. Wheel zoom (dolly) is unaffected.
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: null as unknown as THREE.MOUSE };
controls.update();

// Canvas owns right-click: suppress the native context menu everywhere over it.
renderer.domElement.addEventListener("contextmenu", e => e.preventDefault());

// ── WASD / arrow-key camera panning ─────────────────────────────────────
// Middle-drag orbit + wheel zoom aren't enough to cover a large map — the
// owner asked for keyboard panning too. We move both camera.position and
// controls.target by the same screen-projected delta each frame, which
// preserves OrbitControls' internal spherical offset (same trick its own
// .pan() uses internally), so orbiting/zooming keep working unmodified.
const CAMERA_PAN_SPEED = 15; // world units / second
const CAMERA_PAN_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);
const pressedKeys = new Set<string>();
const panClock = new THREE.Clock();

function updateCameraPan(dt: number): void {
  if (pressedKeys.size === 0) return;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

  const move = new THREE.Vector3();
  if (pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) move.add(forward);
  if (pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown")) move.sub(forward);
  if (pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) move.add(right);
  if (pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft")) move.sub(right);
  if (move.lengthSq() < 1e-9) return;
  move.normalize().multiplyScalar(CAMERA_PAN_SPEED * dt);
  camera.position.add(move);
  controls.target.add(move);
}

// Text fields (grid-size input, server-map select) must keep their own
// keyboard input — WASD/arrows/R/Q/E/Ctrl+Z must not be hijacked while
// the owner is typing in them.
function isTextInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

// ── Editor state ─────────────────────────────────────────────────────────
interface CellRecord { asset: string; x: number; z: number; y_level: number; rot: number; mirror?: boolean }
interface PropRecord { asset: string; x: number; z: number; y_level: number; rot: number; scale: number }

const cells = new Map<string, CellRecord>();
const cellObjs = new Map<string, THREE.Object3D>();
const props: PropRecord[] = [];
const propObjs: THREE.Object3D[] = [];

let lib: AssetLibrary | null = null;
let activeAsset: string | null = null;
let rotIndex = 0;
let yLevel = 0;
let mirrorState = false; // reflect the piece across local X (Space) — see CellDef.mirror
let ghost: THREE.Object3D | null = null;

let lastClientX = innerWidth / 2;
let lastClientY = innerHeight / 2;
let lastCellX = 0;
let lastCellZ = 0;
let lastFloatX = 0;
let lastFloatZ = 0;

// Stacked columns: a cell is addressed by (x, z, y_level), so several assets
// can share one XZ footprint at different heights — e.g. two sideCliffs on top
// of each other forming a 2-level wall, which the Kenney kit has no single
// asset for. Same (x, z, y_level) still means "replace" (swap the asset at that
// exact layer).
function cellKey(x: number, z: number, yLevel: number): string {
  return x + "," + z + "," + yLevel;
}

// Which stacked layer a right-click removes: the one at the active y_level if
// something is placed there (surgical — Q/E to a layer, then erase it), else
// the topmost layer in that column (forgiving, so you don't have to match the
// height exactly to delete a mistake). Returns null if the column is empty.
function cellKeyToDelete(x: number, z: number, activeY: number): string | null {
  const exact = cellKey(x, z, activeY);
  if (cells.has(exact)) return exact;
  let topKey: string | null = null;
  let topY = -Infinity;
  for (const [key, rec] of cells) {
    if (rec.x === x && rec.z === z && rec.y_level > topY) {
      topY = rec.y_level;
      topKey = key;
    }
  }
  return topKey;
}

// Position + rotation + mirror for a placed cell object, in one place so the
// initial placement and the grid-resize reposition (rebuildAllPlacements) can
// never drift apart — the resize path used to reset position without the
// 2-cell offset or the mirror, silently misplacing ramps on grid change.
function applyCellTransform(inst: THREE.Object3D, rec: CellRecord): void {
  inst.position.set(rec.x - HALF, rec.y_level * LEVEL_HEIGHT, rec.z - HALF);
  if (TWO_CELL_ASSETS.has(rec.asset)) {
    const [dx, dz] = longAxis(rec.rot);
    inst.position.x += dx * 0.5;
    inst.position.z += dz * 0.5; // sit on 2 whole cells, not straddling — matches mapLoader
  }
  inst.rotation.y = THREE.MathUtils.degToRad(rec.rot);
  inst.scale.x = rec.mirror ? -1 : 1; // reflect-then-rotate, matches mapLoader
}

// ── Palette UI ───────────────────────────────────────────────────────────
const paletteButtons = new Map<string, HTMLButtonElement>();

// Collapsible categories: which ones are collapsed persists across reloads
// (localStorage), so the owner's sidebar layout stays put session to
// session. Falls back to DEFAULT_COLLAPSED_CATEGORIES (shared/mapAssets.ts)
// the first time, or if the stored value is missing/corrupt.
const COLLAPSE_STORAGE_KEY = "editor-palette-collapsed";

function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch (err) {
    console.error("[editor] failed to parse collapsed-category state, using defaults:", err);
  }
  return new Set(DEFAULT_COLLAPSED_CATEGORIES);
}

const collapsedCategories = loadCollapsedCategories();

function saveCollapsedCategories(): void {
  localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsedCategories]));
}

// Applies the current collapsed/expanded state to one category's DOM (arrow
// glyph on the label + item buttons hidden/shown) without touching the
// persisted set — used both by the click toggle and by the initial build.
function applyCategoryCollapse(category: string, labelEl: HTMLDivElement, itemEls: readonly HTMLButtonElement[]): void {
  const collapsed = collapsedCategories.has(category);
  labelEl.textContent = (collapsed ? "▸ " : "▾ ") + category; // ▸ / ▾
  for (const btn of itemEls) btn.style.display = collapsed ? "none" : "";
}

function toggleCategory(category: string, labelEl: HTMLDivElement, itemEls: readonly HTMLButtonElement[]): void {
  if (collapsedCategories.has(category)) collapsedCategories.delete(category);
  else collapsedCategories.add(category);
  applyCategoryCollapse(category, labelEl, itemEls);
  saveCollapsedCategories();
}

function buildPalette(): void {
  for (const cat of PALETTE) {
    const label = document.createElement("div");
    label.className = "category-label";
    sidebar.appendChild(label);
    const itemEls: HTMLButtonElement[] = [];
    for (const item of cat.items) {
      const btn = document.createElement("button");
      btn.className = "palette-btn";
      // Label lives in its own span so a thumbnail <img> can be prepended
      // later (once the asset library is loaded) without clobbering the text.
      const labelSpan = document.createElement("span");
      labelSpan.className = "palette-label";
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      btn.addEventListener("click", () => selectAsset(item.asset));
      sidebar.appendChild(btn);
      paletteButtons.set(item.asset, btn);
      itemEls.push(btn);
    }
    label.addEventListener("click", () => toggleCategory(cat.category, label, itemEls));
    applyCategoryCollapse(cat.category, label, itemEls);
  }
}

// ── Palette thumbnails ──────────────────────────────────────────────────
// Renders each palette asset's template to a small offscreen canvas once
// the asset library has loaded, and stamps it as an <img> in front of the
// button's label. One shared renderer is reused across all assets (cheaper
// than allocating a WebGL context per thumbnail); failures are swallowed —
// the button just keeps its plain-text label.
const THUMB_RENDER_SIZE = 96; // rendered at 2.4x the ~40px CSS display size
let thumbRenderer: THREE.WebGLRenderer | null = null;

function getThumbRenderer(): THREE.WebGLRenderer {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(THUMB_RENDER_SIZE, THUMB_RENDER_SIZE);
    thumbRenderer.setClearColor(0x000000, 0);
  }
  return thumbRenderer;
}

function renderThumbnail(template: THREE.Object3D): string | null {
  try {
    const r = getThumbRenderer();
    const thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(3, 5, 2);
    thumbScene.add(dir);

    const clone = template.clone(true);
    thumbScene.add(clone);
    const box = new THREE.Box3().setFromObject(clone);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
    clone.position.sub(center); // center the model at the origin for framing

    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    const dist = maxDim * 2.3;
    cam.position.set(dist, dist * 0.85, dist); // fixed iso-ish angle for every asset
    cam.lookAt(0, 0, 0);

    r.render(thumbScene, cam);
    return r.domElement.toDataURL("image/png");
  } catch (err) {
    console.error("[editor] thumbnail render failed:", err);
    return null;
  }
}

function addPaletteThumbnails(): void {
  if (!lib) return;
  for (const cat of PALETTE) {
    for (const item of cat.items) {
      const template = lib.get(item.asset);
      const btn = paletteButtons.get(item.asset);
      if (!template || !btn) continue;
      const dataUrl = renderThumbnail(template);
      if (!dataUrl) continue; // graceful fallback: leave the text-only button
      const img = document.createElement("img");
      img.className = "palette-thumb";
      img.src = dataUrl;
      img.alt = "";
      btn.prepend(img);
    }
  }
  // The offscreen GL context isn't needed again after this pass.
  thumbRenderer?.dispose();
  thumbRenderer = null;
}

function selectAsset(asset: string): void {
  activeAsset = asset;
  for (const [name, btn] of paletteButtons) btn.classList.toggle("active", name === asset);
  rebuildGhost();
  refreshCursor(lastClientX, lastClientY);
}

function deselectAsset(): void {
  activeAsset = null;
  for (const btn of paletteButtons.values()) btn.classList.remove("active");
  if (ghost) { scene.remove(ghost); ghost = null; }
  refreshCursor(lastClientX, lastClientY);
}

// ── Ghost preview ────────────────────────────────────────────────────────
function makeGhostFrom(template: THREE.Object3D): THREE.Object3D {
  const clone = template.clone(true);
  clone.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material;
    const clonedMat = Array.isArray(src) ? src.map(m => m.clone()) : src.clone();
    mesh.material = clonedMat;
    for (const m of Array.isArray(clonedMat) ? clonedMat : [clonedMat]) {
      (m as THREE.Material).transparent = true;
      (m as THREE.Material).opacity = 0.45;
      (m as THREE.Material).depthWrite = false;
    }
  });
  return clone;
}

function rebuildGhost(): void {
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (!activeAsset || !lib) return;
  const template = lib.get(activeAsset);
  if (!template) return;
  ghost = makeGhostFrom(template);
  scene.add(ghost);
}

// ── Cell / prop placement ────────────────────────────────────────────────
function placeCell(rec: CellRecord): void {
  if (!lib) return;
  const key = cellKey(rec.x, rec.z, rec.y_level);
  const existing = cellObjs.get(key);
  if (existing) scene.remove(existing);
  const template = lib.get(rec.asset);
  if (!template) return;
  const inst = template.clone(true);
  applyCellTransform(inst, rec);
  // Tag the root instance so precise-delete (X held) can walk up from
  // whatever child mesh the raycaster actually hits back to "which placed
  // record does this belong to" — see raycastPreciseTarget().
  inst.userData.mapKind = "cell";
  inst.userData.mapKey = key;
  scene.add(inst);
  cells.set(key, rec);
  cellObjs.set(key, inst);
}

function removeCell(key: string): boolean {
  const obj = cellObjs.get(key);
  if (!obj) return false;
  scene.remove(obj);
  cellObjs.delete(key);
  cells.delete(key);
  return true;
}

function addProp(rec: PropRecord): void {
  if (!lib) return;
  const template = lib.get(rec.asset);
  if (!template) return;
  const inst = template.clone(true);
  inst.position.set(rec.x - HALF, rec.y_level * LEVEL_HEIGHT, rec.z - HALF);
  inst.rotation.y = THREE.MathUtils.degToRad(rec.rot);
  inst.scale.setScalar(rec.scale);
  // Same root tagging as placeCell — mapRec holds a direct reference to the
  // record (not an index), matching removePropByRef's identity-based lookup.
  inst.userData.mapKind = "prop";
  inst.userData.mapRec = rec;
  scene.add(inst);
  props.push(rec);
  propObjs.push(inst);
}

// Finds the index of the prop whose cell-space XZ is closest to (x, z),
// within reach, or -1 if none. Split from the removal itself so callers
// (delete handler, undo/redo) can grab the record before it's gone.
function findNearestPropIndex(x: number, z: number, maxDist = 0.6): number {
  let bestIdx = -1;
  let bestDist = maxDist;
  for (let i = 0; i < props.length; i++) {
    const d = Math.hypot(props[i].x - x, props[i].z - z);
    if (d <= bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// Removes a prop by object identity (not by re-deriving position), so undo
// can restore/re-remove the exact same record instance regardless of how
// the array shifted since it was captured.
function removePropByRef(rec: PropRecord): boolean {
  const idx = props.indexOf(rec);
  if (idx < 0) return false;
  scene.remove(propObjs[idx]);
  props.splice(idx, 1);
  propObjs.splice(idx, 1);
  return true;
}

// ── Undo / redo ──────────────────────────────────────────────────────────
// Each entry stores the before/after state of exactly one cell (keyed) or
// prop (by object identity) mutation. Undo restores "before", redo
// re-applies "after" — the same apply function drives both directions.
const UNDO_LIMIT = 50;
interface CellUndoEntry { kind: "cell"; key: string; before: CellRecord | null; after: CellRecord | null }
interface PropUndoEntry { kind: "prop"; before: PropRecord | null; after: PropRecord | null }
// Groups several cell/prop mutations into one undo/redo step — used by
// "Center Map" (btnCenterMap below), which touches every placed cell and
// prop in one user action. `entries` is recorded in the order the mutations
// were applied; undo replays it back-to-front (so removals happen before the
// re-adds they depended on), redo replays it forward.
interface BatchUndoEntry { kind: "batch"; entries: UndoEntry[] }
type UndoEntry = CellUndoEntry | PropUndoEntry | BatchUndoEntry;

const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

function updateUndoButton(): void {
  btnUndo.disabled = undoStack.length === 0;
}

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // a fresh action invalidates the redo history
  updateUndoButton();
}

function applyEntry(entry: UndoEntry, direction: "undo" | "redo"): void {
  if (entry.kind === "batch") {
    const ordered = direction === "undo" ? [...entry.entries].reverse() : entry.entries;
    for (const sub of ordered) applyEntry(sub, direction);
    return;
  }
  if (entry.kind === "cell") {
    const target = direction === "undo" ? entry.before : entry.after;
    if (target) placeCell(target); else removeCell(entry.key);
    return;
  }
  const removeTarget = direction === "undo" ? entry.after : entry.before;
  const restoreTarget = direction === "undo" ? entry.before : entry.after;
  if (removeTarget) removePropByRef(removeTarget);
  if (restoreTarget) addProp(restoreTarget);
}

function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  applyEntry(entry, "undo");
  redoStack.push(entry);
  updateUndoButton();
  refreshCursor(lastClientX, lastClientY);
  scheduleAutosave();
}

function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  applyEntry(entry, "redo");
  undoStack.push(entry);
  updateUndoButton();
  refreshCursor(lastClientX, lastClientY);
  scheduleAutosave();
}

// Re-derives world position (position.x/z depend on HALF) for every already-
// placed cell/prop object, without touching the stored cell-space records.
// Called after GRID_SIZE (and therefore HALF) changes.
function rebuildAllPlacements(): void {
  for (const [key, rec] of cells) {
    const obj = cellObjs.get(key);
    if (obj) applyCellTransform(obj, rec);
  }
  for (let i = 0; i < props.length; i++) {
    propObjs[i].position.set(props[i].x - HALF, props[i].y_level * LEVEL_HEIGHT, props[i].z - HALF);
  }
}

// Changes the grid size: recreates the GridHelper, updates HALF (which
// shifts every already-placed object's world position to match — cell-space
// records are unaffected), and re-clamps the cursor to the new bounds.
function setGridSize(size: number): void {
  const clamped = THREE.MathUtils.clamp(
    Math.round(size / GRID_SIZE_STEP) * GRID_SIZE_STEP,
    MIN_GRID_SIZE, MAX_GRID_SIZE
  );
  if (clamped === GRID_SIZE) return;
  GRID_SIZE = clamped;
  HALF = (GRID_SIZE - 1) / 2;
  scene.remove(grid);
  grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x00ffee, 0x333366);
  scene.add(grid);
  gridSizeInput.value = String(GRID_SIZE);
  rebuildAllPlacements();
  refreshCursor(lastClientX, lastClientY);
}

// Shifts EVERY placed cell and prop by the same integer (dx, dz) so the
// content's own bounding-box center lands on the grid's center — handy after
// building off to one side, or after Import brings in a map authored around
// different coordinates. Recorded as a single batch undo entry (see
// BatchUndoEntry) so one Ctrl+Z reverts the whole shift, not one tile at a
// time. dx/dz are rounded to whole cells — props keep their PROP_STEP
// sub-cell offset within the cell, since the shift itself is integer.
function centerMap(): void {
  if (cells.size === 0 && props.length === 0) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const rec of cells.values()) {
    minX = Math.min(minX, rec.x); maxX = Math.max(maxX, rec.x);
    minZ = Math.min(minZ, rec.z); maxZ = Math.max(maxZ, rec.z);
  }
  for (const p of props) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const dx = Math.round(HALF - (minX + maxX) / 2);
  const dz = Math.round(HALF - (minZ + maxZ) / 2);
  if (dx === 0 && dz === 0) return;

  // Snapshot before mutating — cells/props arrays/maps change as we go.
  const oldCells = Array.from(cells.values());
  const oldProps = props.slice();
  const batch: UndoEntry[] = [];

  // Remove everything first (recording "after: null" entries), THEN place
  // the shifted copies — doing remove+place per-record interleaved risks a
  // shifted record's new key colliding with an old record that hasn't been
  // processed yet (the shift is a uniform integer offset, so keys stay
  // unique overall, but only once ALL old keys are cleared first).
  for (const rec of oldCells) {
    const oldKey = cellKey(rec.x, rec.z, rec.y_level);
    removeCell(oldKey);
    batch.push({ kind: "cell", key: oldKey, before: rec, after: null });
  }
  for (const rec of oldProps) {
    removePropByRef(rec);
    batch.push({ kind: "prop", before: rec, after: null });
  }
  for (const rec of oldCells) {
    const moved: CellRecord = { ...rec, x: rec.x + dx, z: rec.z + dz };
    placeCell(moved);
    batch.push({ kind: "cell", key: cellKey(moved.x, moved.z, moved.y_level), before: null, after: moved });
  }
  for (const rec of oldProps) {
    const moved: PropRecord = { ...rec, x: rec.x + dx, z: rec.z + dz };
    addProp(moved);
    batch.push({ kind: "prop", before: null, after: moved });
  }

  pushUndo({ kind: "batch", entries: batch });
  refreshCursor(lastClientX, lastClientY);
  scheduleAutosave();
}

function clearAll(): void {
  for (const obj of cellObjs.values()) scene.remove(obj);
  cells.clear();
  cellObjs.clear();
  for (const obj of propObjs) scene.remove(obj);
  props.length = 0;
  propObjs.length = 0;
  // A bulk clear/import/load invalidates any prior undo history — replaying
  // an old entry against the now-cleared map would resurrect stale records.
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoButton();
}

// ── Raycast / cursor ─────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hitPoint = new THREE.Vector3();

function updatePlane(): void {
  groundPlane.constant = -(yLevel * LEVEL_HEIGHT);
}
updatePlane();

// ── Precise delete (X held) ──────────────────────────────────────────────
// Regular right-click delete snaps to the grid cell under the cursor and
// picks the top of that column — great for "I clicked the wrong tile,
// undo/redo it" but useless for carving a tunnel through the *middle* of a
// stacked wall (wall_block columns), because you can never aim at anything
// but the topmost block in a column. Precise delete instead raycasts
// against the actual placed meshes, so whatever the camera is looking
// straight at — including a mid-stack block hidden behind ones "in front"
// of it from the top-down grid's point of view, but not from this ray's —
// is exactly what gets removed.
type PreciseTarget =
  | { kind: "cell"; key: string; root: THREE.Object3D }
  | { kind: "prop"; rec: PropRecord; root: THREE.Object3D };

let preciseDeleteMode = false;
let preciseTarget: PreciseTarget | null = null;
// Highlight is a wireframe AABB box, not a material/emissive tint. Every
// placed instance is template.clone(true) — three.js clone() copies the
// Object3D graph but keeps the SAME Material references across all clones
// of one template (that's the whole point, it's what makes instancing
// cheap). Mutating a hit mesh's material .emissive directly would therefore
// recolor every OTHER copy of that same asset on the map too. A separate
// Box3Helper line-box drawn around the target's world AABB sidesteps that
// entirely — it owns its own tiny geometry/material, never touches the
// target's own material, and costs one dispose() on cleanup.
let deleteHighlight: THREE.Box3Helper | null = null;

function clearDeleteHighlight(): void {
  if (!deleteHighlight) return;
  scene.remove(deleteHighlight);
  deleteHighlight.geometry.dispose();
  (deleteHighlight.material as THREE.Material).dispose();
  deleteHighlight = null;
}

function setDeleteHighlight(root: THREE.Object3D | null): void {
  clearDeleteHighlight();
  if (!root) return;
  const box = new THREE.Box3().setFromObject(root); // world-space AABB, handles mirror (scale.x=-1) and rotation fine
  deleteHighlight = new THREE.Box3Helper(box, 0xff2222);
  scene.add(deleteHighlight);
}

// Raycasts from the last known cursor position against every placed cell
// and prop instance (recursive, so it hits child meshes of multi-mesh
// templates), then walks up from whatever was hit to the tagged root
// (see placeCell/addProp's userData.mapKind) so a 2-cell asset's second
// mesh or a nested child still resolves to the ONE record it belongs to.
function raycastPreciseTarget(): PreciseTarget | null {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((lastClientX - rect.left) / rect.width) * 2 - 1,
    -((lastClientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const candidates: THREE.Object3D[] = [...cellObjs.values(), ...propObjs];
  const hits = raycaster.intersectObjects(candidates, true);
  if (hits.length === 0) return null;
  let obj: THREE.Object3D | null = hits[0].object;
  while (obj && !obj.userData.mapKind) obj = obj.parent;
  if (!obj) return null;
  if (obj.userData.mapKind === "cell") {
    return { kind: "cell", key: obj.userData.mapKey as string, root: obj };
  }
  if (obj.userData.mapKind === "prop") {
    return { kind: "prop", rec: obj.userData.mapRec as PropRecord, root: obj };
  }
  return null;
}

function updatePreciseStatusBar(): void {
  if (!preciseTarget) {
    statusMain.textContent = "precise-delete (X): наведи на блок";
    statusHint.textContent = "ЛКМ / ПКМ — удалить объект под курсором · отпусти X — выйти из режима";
    return;
  }
  if (preciseTarget.kind === "cell") {
    const rec = cells.get(preciseTarget.key);
    statusMain.textContent = rec
      ? `precise-delete: ${rec.asset}  cell: (${rec.x}, ${rec.z})  y_level: ${rec.y_level}`
      : "precise-delete (X): наведи на блок";
  } else {
    const rec = preciseTarget.rec;
    statusMain.textContent =
      `precise-delete: ${rec.asset}  prop @ (${rec.x.toFixed(2)}, ${rec.z.toFixed(2)})  y_level: ${rec.y_level}`;
  }
  statusHint.textContent = "ЛКМ / ПКМ — удалить подсвеченный объект · отпусти X — выйти из режима";
}

// Called from refreshCursor whenever preciseDeleteMode is on, instead of
// the normal ground-plane cell/ghost logic.
function updatePreciseDeleteHover(): void {
  preciseTarget = raycastPreciseTarget();
  setDeleteHighlight(preciseTarget?.root ?? null);
  updatePreciseStatusBar();
}

// Deletes exactly the currently-highlighted target (re-raycast at the
// current cursor position happens beforehand, in pointerdown -> refreshCursor
// -> updatePreciseDeleteHover, so this always acts on a fresh hit). Reuses
// the same undo-entry shapes as the normal left/right-click handlers so
// Ctrl+Z/Z-Y work identically for tunnel-digging as for any other edit.
function deletePreciseTarget(): void {
  if (!preciseTarget) return;
  if (preciseTarget.kind === "cell") {
    const before = cells.get(preciseTarget.key) ?? null;
    if (!before) return;
    if (removeCell(preciseTarget.key)) {
      pushUndo({ kind: "cell", key: preciseTarget.key, before, after: null });
      scheduleAutosave();
    }
  } else {
    const rec = preciseTarget.rec;
    if (removePropByRef(rec)) {
      pushUndo({ kind: "prop", before: rec, after: null });
      scheduleAutosave();
    }
  }
  // Re-hover immediately at the same screen position — carving a tunnel is
  // a rapid-fire sequence of clicks without moving the mouse, so the next
  // block back should light up right away instead of waiting for a
  // pointermove that may never come between clicks.
  updatePreciseDeleteHover();
}

// Recomputes the cursor's cell-space position from a client (screen) point,
// updates the ghost + status bar. Called on pointermove and whenever rot /
// y_level / active asset change (using the last known cursor position).
function refreshCursor(clientX: number, clientY: number): void {
  lastClientX = clientX;
  lastClientY = clientY;
  if (preciseDeleteMode) {
    if (ghost) ghost.visible = false; // no placement while carving/deleting precisely
    updatePreciseDeleteHover();
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);

  const rot = ROT_CYCLE[rotIndex];
  if (hit) {
    const cellSpaceX = hit.x + HALF;
    const cellSpaceZ = hit.z + HALF;
    lastCellX = THREE.MathUtils.clamp(Math.round(cellSpaceX), 0, GRID_SIZE - 1);
    lastCellZ = THREE.MathUtils.clamp(Math.round(cellSpaceZ), 0, GRID_SIZE - 1);
    lastFloatX = THREE.MathUtils.clamp(Math.round(cellSpaceX / PROP_STEP) * PROP_STEP, 0, GRID_SIZE - 1);
    lastFloatZ = THREE.MathUtils.clamp(Math.round(cellSpaceZ / PROP_STEP) * PROP_STEP, 0, GRID_SIZE - 1);
  }

  if (ghost && activeAsset) {
    ghost.visible = true;
    if (isPropAsset(activeAsset)) {
      ghost.position.set(lastFloatX - HALF, yLevel * LEVEL_HEIGHT, lastFloatZ - HALF);
    } else {
      ghost.position.set(lastCellX - HALF, yLevel * LEVEL_HEIGHT, lastCellZ - HALF);
      if (TWO_CELL_ASSETS.has(activeAsset)) {
        const [dx, dz] = longAxis(rot);
        ghost.position.x += dx * 0.5;
        ghost.position.z += dz * 0.5; // preview the 2-cell footprint offset
      }
    }
    ghost.rotation.y = THREE.MathUtils.degToRad(rot);
    ghost.scale.x = mirrorState ? -1 : 1; // preview the mirror before placing
  }

  updateStatusBar(rot);
}

function hintFor(asset: string | null): string {
  if (!asset) return "";
  if (asset === "wall_block") {
    return "стена — непроходимо. y_level = низ блока (растёт вверх). Ставь по краю плато / стакай по высоте";
  }
  if (asset === "wall_block_round") {
    return "стена со скруглённым верхним краем — непроходимо. R крутит куда смотрит скруглённая сторона. y_level = низ блока";
  }
  if (asset === "wall_block_corner") {
    return "угловая стена (два скруглённых верхних края + блендом в углу) — непроходимо. R крутит куда смотрит угол. y_level = низ блока";
  }
  if (asset === "ground_block") {
    return "ПРОЕЗЖАЕМЫЙ куб — верх куба = земля (y_level+1). Для гор/плато из кубиков, заезд через рампу или склон";
  }
  // See .claude/rules/map-building.md — these two families use OPPOSITE
  // y_level conventions and mixing them up is the classic map-building bug.
  // terrain_sideCliff MUST be checked before the generic "terrain_side"
  // check below — "terrain_sideCliff".startsWith("terrain_side") is true,
  // and cliff's mesh is ramp-like ABOVE the pivot (same as sideCorner/ramp),
  // so its y_level means the LOW edge, not the HIGH edge like plain side.
  // (Physics no longer reads cliff's y_level at all — see shared/heightfield.ts
  // isWallOnlyAsset — but this still controls where the VISUAL mesh sits.)
  if (asset.startsWith("terrain_sideCorner") || asset === "terrain_ramp" || asset.startsWith("terrain_sideCliff")) {
    return "y_level = НИЖНИЙ уровень (плитка поднимается вверх от него)";
  }
  if (asset.startsWith("terrain_side")) {
    return "y_level = ВЕРХНИЙ уровень (плитка спускается вниз от него)";
  }
  return "";
}

function updateStatusBar(rot: number): void {
  const assetLabel = activeAsset ?? "(none)";
  const mir = mirrorState ? "  mirror: ON" : "";
  statusMain.textContent =
    `asset: ${assetLabel}  rot: ${rot}${mir}  y_level: ${yLevel}  cell: (${lastCellX}, ${lastCellZ})`;
  statusHint.textContent = hintFor(activeAsset);
}

// ── Pointer input: LEFT place, RIGHT delete ─────────────────────────────
renderer.domElement.addEventListener("pointermove", e => {
  refreshCursor(e.clientX, e.clientY);
});

renderer.domElement.addEventListener("pointerdown", e => {
  refreshCursor(e.clientX, e.clientY);
  if (preciseDeleteMode) {
    // Both buttons delete in this mode — there's no "place" to distinguish
    // between, and forcing the owner to remember which button does what
    // while they're heads-down staring through a wall isn't worth it.
    if (e.button === 0 || e.button === 2) deletePreciseTarget();
    return;
  }
  if (e.button === 0) {
    // Left click: place the active asset (no-op if nothing selected).
    if (!activeAsset) return;
    const rot = ROT_CYCLE[rotIndex];
    if (isPropAsset(activeAsset)) {
      const rec: PropRecord = { asset: activeAsset, x: lastFloatX, z: lastFloatZ, y_level: yLevel, rot, scale: 1.0 };
      addProp(rec);
      pushUndo({ kind: "prop", before: null, after: rec });
    } else {
      const key = cellKey(lastCellX, lastCellZ, yLevel);
      const before = cells.get(key) ?? null;
      const rec: CellRecord = { asset: activeAsset, x: lastCellX, z: lastCellZ, y_level: yLevel, rot };
      if (mirrorState) rec.mirror = true;
      placeCell(rec);
      pushUndo({ kind: "cell", key, before, after: rec });
    }
    scheduleAutosave();
  } else if (e.button === 2) {
    // Right click: delete whatever is under the cursor. Usually that's a
    // snapped cell tile first, then the nearest prop — but a prop resting
    // at or above the top of the cell stack at this spot (e.g. a rock
    // placed on a road tile) is the visible top layer, so it should come
    // off first instead of the road underneath it. See deletePriority.ts.
    const propIdx = findNearestPropIndex(lastFloatX, lastFloatZ);
    const topCellY = topCellYLevelAt(cells.values(), lastCellX, lastCellZ);
    const propY = propIdx >= 0 ? props[propIdx].y_level : null;

    if (shouldDeletePropFirst(topCellY, propY)) {
      const rec = props[propIdx];
      removePropByRef(rec);
      pushUndo({ kind: "prop", before: rec, after: null });
      scheduleAutosave();
      return;
    }

    const key = cellKeyToDelete(lastCellX, lastCellZ, yLevel);
    const cellBefore = key ? cells.get(key) ?? null : null;
    const removedCell = key ? removeCell(key) : false;
    if (removedCell && key) {
      pushUndo({ kind: "cell", key, before: cellBefore, after: null });
      scheduleAutosave();
      return;
    }
    if (propIdx >= 0) {
      const rec = props[propIdx];
      removePropByRef(rec);
      pushUndo({ kind: "prop", before: rec, after: null });
      scheduleAutosave();
    }
  }
});

// ── Keyboard: R rotate, Q/E y_level, WASD/arrows pan, Ctrl+Z undo, Esc ──
addEventListener("keydown", e => {
  if (isTextInputFocused()) return;

  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === "KeyZ") {
    e.preventDefault();
    undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) {
    e.preventDefault();
    redo();
    return;
  }
  // Bare Z / Y — modifier-free undo/redo. Cmd+Z works too (metaKey above), but
  // Dima is on a Mac and wanted plain keys; the placement keys are all mouse +
  // R/Q/E, so bare Z/Y don't collide with anything (text inputs already bail
  // out at the top via isTextInputFocused).
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyZ") {
    undo();
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyY") {
    redo();
    return;
  }

  if (e.code === "KeyX") {
    // Held-key mode toggle, not a one-shot action — guard against the flood
    // of repeat keydown events the browser fires while a key stays down
    // (e.repeat) so we don't redo the enter-mode work every ~30ms.
    if (!preciseDeleteMode) {
      preciseDeleteMode = true;
      refreshCursor(lastClientX, lastClientY);
    }
    e.preventDefault();
    return;
  }

  if (e.code === "KeyR") {
    rotIndex = (rotIndex + 1) % ROT_CYCLE.length;
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "Space") {
    // Mirror the piece across its local X axis — the 4 orientations rotation
    // can't reach on chiral tiles (roadCorner/Split, sideEnd, detailed ramps).
    e.preventDefault(); // Space would otherwise scroll the page
    mirrorState = !mirrorState;
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "KeyQ") {
    yLevel = THREE.MathUtils.clamp(yLevel - 1, 0, MAX_Y_LEVEL);
    updatePlane();
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "KeyE") {
    yLevel = THREE.MathUtils.clamp(yLevel + 1, 0, MAX_Y_LEVEL);
    updatePlane();
    refreshCursor(lastClientX, lastClientY);
  } else if (e.code === "Escape") {
    closeMapsMenu();
    deselectAsset();
  } else if (CAMERA_PAN_KEYS.has(e.code)) {
    pressedKeys.add(e.code);
    e.preventDefault();
  }
});

addEventListener("keyup", e => {
  pressedKeys.delete(e.code);
  if (e.code === "KeyX") {
    preciseDeleteMode = false;
    preciseTarget = null;
    clearDeleteHighlight();
    refreshCursor(lastClientX, lastClientY); // restores ghost visibility + normal status bar
  }
});

// If focus leaves the window mid-pan (alt-tab, devtools) the keyup never
// fires — clear held keys (and exit precise-delete mode the same way) so
// nothing gets stuck on when focus returns.
addEventListener("blur", () => {
  pressedKeys.clear();
  if (preciseDeleteMode) {
    preciseDeleteMode = false;
    preciseTarget = null;
    clearDeleteHighlight();
  }
});

btnUndo.addEventListener("click", () => undo());
updateUndoButton();
btnCenterMap.addEventListener("click", () => centerMap());

// ── Export / Import / Clear / Drive ─────────────────────────────────────
function buildMapJson(): MapJson {
  return {
    meta: {
      tile_size: TILE_SIZE,
      level_height: LEVEL_HEIGHT,
      origin_offset: [-HALF, 0, -HALF],
    },
    cells: Array.from(cells.values()),
    props: props.map(p => ({ ...p })),
  };
}

// Loads a MapJson into the editor (used by both Import and autosave-restore).
// rect_fills are expanded into individual cell placements — the editor's
// data model has no notion of a rectangle, only per-cell records.
function loadMapJson(data: MapJson): void {
  clearAll();
  for (const rect of data.rect_fills ?? []) {
    for (let x = rect.x_min; x <= rect.x_max; x++) {
      for (let z = rect.z_min; z <= rect.z_max; z++) {
        placeCell({ asset: rect.asset, x, z, y_level: rect.y_level, rot: rect.rot ?? 0 });
      }
    }
  }
  for (const cell of data.cells ?? []) {
    const rec: CellRecord = { asset: cell.asset, x: cell.x, z: cell.z, y_level: cell.y_level, rot: cell.rot ?? 0 };
    if (cell.mirror) rec.mirror = true;
    placeCell(rec);
  }
  for (const prop of data.props ?? []) {
    addProp({
      asset: prop.asset, x: prop.x, z: prop.z, y_level: prop.y_level,
      rot: prop.rot ?? 0, scale: prop.scale ?? 1.0,
    });
  }
}

// Finds the largest cell-space coordinate used anywhere in a MapJson (rect
// fills, cells, props), so the editor grid can auto-fit around an imported
// or server-loaded map instead of clipping it against the default 32x32.
function maxCoordOf(data: MapJson): number {
  let max = 0;
  for (const r of data.rect_fills ?? []) max = Math.max(max, r.x_max, r.z_max);
  for (const c of data.cells ?? []) max = Math.max(max, c.x, c.z);
  for (const p of data.props ?? []) max = Math.max(max, p.x, p.z);
  return max;
}

// Grows the grid to comfortably fit a loaded map when it doesn't already:
// +4 cells of margin past the farthest placed tile, rounded up to the next
// multiple of GRID_SIZE_STEP. Never shrinks — loading a small map after a
// big one keeps the current (larger) grid, per owner's call.
function fitGridToMap(data: MapJson): void {
  const needed = Math.ceil((maxCoordOf(data) + 4) / GRID_SIZE_STEP) * GRID_SIZE_STEP;
  if (needed > GRID_SIZE) setGridSize(needed);
}

document.getElementById("btnExport")!.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(buildMapJson(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "map.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("fileImport")!.addEventListener("change", e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then(text => {
    const data = JSON.parse(text) as MapJson;
    loadMapJson(data);
    fitGridToMap(data);
    loadedMapName = file.name.replace(/\.json$/i, "");
    updateMapNameLabel();
    scheduleAutosave();
  }).catch(err => console.error("[editor] import failed:", err));
  input.value = ""; // allow re-importing the same filename later
});

document.getElementById("btnClear")!.addEventListener("click", () => {
  if (!confirm("Clear the whole map?")) return;
  clearAll();
  scheduleAutosave();
});

// New: blank canvas from scratch. Unlike Clear (which just empties the current
// map keeping its name), New also forgets the loaded name so a later "Save to
// server" prompts for a fresh filename instead of silently overwriting the map
// you started from — the natural "I want to build a brand-new example" flow.
document.getElementById("btnNew")!.addEventListener("click", () => {
  if (cells.size > 0 || props.length > 0) {
    if (!confirm("Start a new blank map? Unsaved changes will be lost.")) return;
  }
  clearAll();
  loadedMapName = null;
  updateMapNameLabel();
  scheduleAutosave();
  showServerStatus("new blank map", "ok");
});

document.getElementById("btnDrive")!.addEventListener("click", () => {
  // Stamp WHICH map + WHEN alongside the snapshot. The game route (?map=editor)
  // drives this frozen snapshot, NOT the live disk map — so if the disk copy
  // changes later, Drive still shows the old bits until re-loaded here. The
  // meta lets the game show an "editor snapshot · name · age" badge so a stale
  // snapshot can never masquerade as the live map again (the bug where a
  // pre-edit mars_base kept rendering after the disk map was regenerated).
  localStorage.setItem("editor-drive-map", JSON.stringify(buildMapJson()));
  localStorage.setItem("editor-drive-meta",
    JSON.stringify({ name: loadedMapName ?? "unsaved", ts: Date.now() }));
  window.open("/?map=editor", "_blank");
});

gridSizeInput.addEventListener("change", () => {
  setGridSize(Number(gridSizeInput.value) || GRID_SIZE);
});

// ── Save/Load via the dev server (vite.config.ts editorMapsFilePlugin) ────
// Closes the loop for the two-laptop LAN setup: the editor's Export/Import
// buttons only touch the browser's local filesystem, which is useless when
// the editor is opened from a laptop other than the one the repo lives on.
let loadedMapName: string | null = null;

// Reflects loadedMapName in the topbar so "which map am I editing, and will
// Save silently overwrite it or ask me for a name" is always visible —
// see Save/Save As wiring further down.
function updateMapNameLabel(): void {
  mapNameLabel.textContent = loadedMapName ? `Map: ${loadedMapName}` : "Map: (unsaved)";
}

function showServerStatus(text: string, kind: "ok" | "error"): void {
  serverStatus.textContent = text;
  serverStatus.className = kind;
  setTimeout(() => { serverStatus.textContent = ""; serverStatus.className = ""; }, 4000);
}

// Names come back sorted by the dev server's readdirSync order (filesystem-
// dependent, not guaranteed alphabetical, but stable enough for a small
// personal map list); renderMapsMenu() rebuilds the panel rows from this
// cache on every open, so the confirm-to-delete state below never survives
// a reopen.
let knownMapNames: string[] = [];

async function refreshServerMapList(): Promise<void> {
  try {
    const res = await fetch("/__editor-maps");
    if (!res.ok) throw new Error(String(res.status));
    const { maps } = (await res.json()) as { maps: string[] };
    knownMapNames = maps;
    renderMapsMenu();
  } catch (err) {
    console.error("[editor] failed to list server maps:", err);
  }
}

// Rebuilds the maps-menu panel's rows from knownMapNames. Called both when
// the list changes (after save/delete) and every time the panel is opened,
// so a half-confirmed delete button never lingers into the next session —
// reopening always starts from a clean "🗑" state.
function renderMapsMenu(): void {
  mapsMenuPanel.innerHTML = "";
  if (knownMapNames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "maps-menu-empty";
    empty.textContent = "(нет сохранённых карт)";
    mapsMenuPanel.appendChild(empty);
    return;
  }
  for (const name of knownMapNames) {
    const row = document.createElement("div");
    row.className = "maps-menu-row";

    const nameBtn = document.createElement("button");
    nameBtn.className = "maps-menu-name";
    nameBtn.textContent = name;
    nameBtn.addEventListener("click", () => loadFromServer(name));
    row.appendChild(nameBtn);

    // Two-click delete, inline — mirrors Save As's "no window.confirm()"
    // rule. First click arms it ("точно?"); a second click on the SAME
    // button deletes. Clicking anything else closes the panel (see the
    // document-level click listener below), which discards the arm state
    // along with the DOM node, so there's no dangling timer to clean up.
    const delBtn = document.createElement("button");
    delBtn.className = "maps-menu-del";
    delBtn.textContent = "🗑";
    delBtn.title = `Удалить ${name}.json (уходит в public/maps/.backup/, можно восстановить)`;
    let confirming = false;
    delBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (!confirming) {
        confirming = true;
        delBtn.textContent = "точно?";
        delBtn.classList.add("confirm");
        return;
      }
      deleteFromServer(name);
    });
    row.appendChild(delBtn);

    mapsMenuPanel.appendChild(row);
  }
}

function openMapsMenu(): void {
  renderMapsMenu(); // fresh rows — resets any armed delete confirmation
  mapsMenuPanel.classList.remove("hidden");
}

function closeMapsMenu(): void {
  mapsMenuPanel.classList.add("hidden");
}

btnMapsMenu.addEventListener("click", ev => {
  ev.stopPropagation();
  if (mapsMenuPanel.classList.contains("hidden")) openMapsMenu();
  else closeMapsMenu();
});

// Click-outside-to-close, same pattern as any other dropdown — the panel
// itself and its opener button are exempt so clicking a row or re-toggling
// the button doesn't immediately close what it just opened.
document.addEventListener("click", e => {
  if (mapsMenuPanel.classList.contains("hidden")) return;
  const target = e.target as Node;
  if (mapsMenuPanel.contains(target) || target === btnMapsMenu) return;
  closeMapsMenu();
});

function loadFromServer(name: string): void {
  closeMapsMenu();
  fetch(`/maps/${name}.json`)
    .then(res => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    })
    .then((data: MapJson) => {
      loadMapJson(data);
      fitGridToMap(data);
      loadedMapName = name;
      updateMapNameLabel();
      scheduleAutosave();
      showServerStatus(`loaded ${name}`, "ok");
    })
    .catch(err => {
      console.error("[editor] load from server failed:", err);
      showServerStatus(`load failed: ${String(err)}`, "error");
    });
}

// Deletion is a rename-to-backup on the server (see vite.config.ts), never
// an unlink — this is just the client half of that contract. If the
// deleted map was the one currently open, the loaded name is cleared (but
// the scene content is left alone — the owner may want to Save As right
// away) and the label falls back to "(unsaved)".
function deleteFromServer(name: string): void {
  fetch("/__editor-maps", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
    .then(res => {
      if (!res.ok) return res.text().then(msg => { throw new Error(msg || String(res.status)); });
      if (loadedMapName === name) {
        loadedMapName = null;
        updateMapNameLabel();
      }
      showServerStatus(`deleted ${name}.json`, "ok");
      return refreshServerMapList(); // re-renders the (still open) panel with the map gone
    })
    .catch(err => {
      console.error("[editor] delete from server failed:", err);
      showServerStatus(`delete failed: ${String(err)}`, "error");
    });
}

// Save writes straight to the currently-loaded map name — no prompt, no
// confirmation, just overwrite (matches every other "Save" button anywhere).
// Save As always asks for a name via the inline panel below, never
// window.prompt() (prompt() blocks agent-driven browser automation and
// looks out of place next to the rest of this UI). A brand-new/unnamed map
// has nothing to silently overwrite, so plain Save falls through to the
// Save As panel too in that case.
const MAP_NAME_RE = /^[a-z0-9_-]+$/i;
const btnSave = document.getElementById("btnSave") as HTMLButtonElement;
const btnSaveAs = document.getElementById("btnSaveAs") as HTMLButtonElement;
const saveAsPanel = document.getElementById("saveAsPanel")!;
const saveAsInput = document.getElementById("saveAsInput") as HTMLInputElement;

function saveToServer(name: string): void {
  fetch("/__editor-maps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data: buildMapJson() }),
  })
    .then(res => {
      if (!res.ok) return res.text().then(msg => { throw new Error(msg || String(res.status)); });
      loadedMapName = name;
      updateMapNameLabel();
      showServerStatus(`saved ${name}.json`, "ok");
      return refreshServerMapList();
    })
    .catch(err => {
      console.error("[editor] save to server failed:", err);
      showServerStatus(`save failed: ${String(err)}`, "error");
    });
}

function openSaveAsPanel(): void {
  saveAsInput.value = loadedMapName ?? "map";
  saveAsPanel.classList.remove("hidden");
  saveAsInput.focus();
  saveAsInput.select();
}

function closeSaveAsPanel(): void {
  saveAsPanel.classList.add("hidden");
}

function confirmSaveAs(): void {
  const name = saveAsInput.value.trim();
  if (!name || !MAP_NAME_RE.test(name)) {
    showServerStatus("invalid name (letters/digits/-/_ only)", "error");
    return;
  }
  closeSaveAsPanel();
  saveToServer(name);
}

btnSave.addEventListener("click", () => {
  if (loadedMapName) saveToServer(loadedMapName);
  else openSaveAsPanel();
});
btnSaveAs.addEventListener("click", () => openSaveAsPanel());
document.getElementById("saveAsConfirm")!.addEventListener("click", () => confirmSaveAs());
document.getElementById("saveAsCancel")!.addEventListener("click", () => closeSaveAsPanel());
saveAsInput.addEventListener("keydown", e => {
  // Own handler, not the global WASD/undo one — isTextInputFocused() makes
  // that one bail out entirely while this input is focused (see its guard),
  // so Enter/Escape need to be wired here instead.
  if (e.key === "Enter") { e.preventDefault(); confirmSaveAs(); }
  else if (e.key === "Escape") { e.preventDefault(); closeSaveAsPanel(); }
});

// ── Autosave (debounced) ─────────────────────────────────────────────────
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    localStorage.setItem("editor-autosave", JSON.stringify(buildMapJson()));
  }, 500);
}

// ── Boot ─────────────────────────────────────────────────────────────────
(async () => {
  buildPalette();
  lib = await loadAssetLibrary(ASSET_NAMES);
  addPaletteThumbnails();
  void refreshServerMapList();
  const saved = localStorage.getItem("editor-autosave");
  if (saved) {
    try {
      const data = JSON.parse(saved) as MapJson;
      loadMapJson(data);
      fitGridToMap(data);
    }
    catch (err) { console.error("[editor] autosave restore failed:", err); }
  }
  statusMain.textContent = "asset: (none)  rot: 0  y_level: 0  cell: (—, —)";
  updateMapNameLabel(); // autosave restore never sets loadedMapName -> shows "(unsaved)" until Load/Save
  refreshCursor(lastClientX, lastClientY);
})();

function frame(): void {
  requestAnimationFrame(frame);
  updateCameraPan(panClock.getDelta());
  controls.update();
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
