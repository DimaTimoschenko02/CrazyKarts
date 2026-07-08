// Assembly showcase — the "how do the pieces COMBINE correctly" companion to
// assetDiag/main.ts (which only shows single assets at 4 rotations). Every
// assembly here is built through the REAL GameMap loader + heightfield, so
// what renders is exactly what the game does: a corner gap seen here is a gap
// in-game, and the recipe that closes it here is the recipe gen_mars_base.py
// must emit. Dev/study aid — this is the cheat-sheet the map generator is
// derived from, and the visual menu Dima picks terrain features from.
import * as THREE from "three";
import { loadAssetLibrary } from "../map/assetLoader";
import { GameMap } from "../map/mapLoader";
import type { CellDef, MapJson } from "../shared/heightfield";

// Every asset any assembly can reference.
const ASSETS = [
  "terrain", "terrain_ramp", "terrain_rampLarge",
  "terrain_side", "terrain_sideCorner", "terrain_sideCornerInner",
  "terrain_sideCliff", "terrain_roadStraight", "terrain_roadCorner",
  "terrain_roadEnd",
];

// ── Skirt classifier (faithful copy of gen_mars_base.py) ────────────────────
// Given a LEVEL map (cell -> y_level) plus explicit ramps, emit the cell list
// with auto-derived side / sideCorner / sideCornerInner skirts. This is the
// SAME logic the Python generator uses; mirroring it here means the showcase
// exercises the real recipe, not a hand-faked one.
const SIDE_ROT: Record<string, number> = { "0,1": 0, "1,0": 90, "0,-1": 180, "-1,0": 270 };
const INNER_ROT: Record<string, number> = { "1,-1": 0, "1,1": 90, "-1,1": 180, "-1,-1": 270 };
const CORNER_ROT: Record<string, number> = { "-1,1": 0, "1,1": 90, "1,-1": 180, "-1,-1": 270 };
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

interface Feature {
  level: Map<string, number>;
  ramps: Map<string, number>; // "x,z" -> rot
  roads: Map<string, [string, number]>;
}

function classify(f: Feature): CellDef[] {
  const lv = (x: number, z: number): number => f.level.get(`${x},${z}`) ?? -99;
  const cells: CellDef[] = [];
  for (const [key, level] of [...f.level.entries()].sort()) {
    const [x, z] = key.split(",").map(Number);
    if (f.ramps.has(key)) {
      cells.push({ asset: "terrain_ramp", x, z, y_level: level, rot: f.ramps.get(key)! });
      continue;
    }
    const higher = DIRS.filter(([dx, dz]) => lv(x + dx, z + dz) === level + 1);
    if (higher.length === 1) {
      const [dx, dz] = higher[0];
      cells.push({ asset: "terrain_side", x, z, y_level: level + 1, rot: SIDE_ROT[`${dx},${dz}`] });
    } else if (higher.length === 2) {
      const [a, b] = higher;
      if (a[0] + b[0] === 0 && a[1] + b[1] === 0) {
        cells.push({ asset: "terrain", x, z, y_level: level }); // 1-wide channel, punt
      } else {
        const low = `${-(a[0] + b[0])},${-(a[1] + b[1])}`;
        cells.push({ asset: "terrain_sideCornerInner", x, z, y_level: level, rot: INNER_ROT[low] });
      }
    } else if (higher.length >= 3) {
      cells.push({ asset: "terrain", x, z, y_level: level });
    } else {
      const diag = DIAGS.filter(([dx, dz]) => lv(x + dx, z + dz) === level + 1);
      if (diag.length > 0) {
        cells.push({ asset: "terrain_sideCorner", x, z, y_level: level, rot: CORNER_ROT[`${diag[0][0]},${diag[0][1]}`] });
      } else if (f.roads.has(key)) {
        const [asset, rot] = f.roads.get(key)!;
        cells.push({ asset, x, z, y_level: level, rot });
      } else {
        cells.push({ asset: "terrain", x, z, y_level: level });
      }
    }
  }
  return cells;
}

// Build a feature helper: fill a rectangle to a level.
function fillRect(f: Feature, x0: number, x1: number, z0: number, z1: number, level: number): void {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) f.level.set(`${x},${z}`, level);
}
function newFeature(): Feature {
  return { level: new Map(), ramps: new Map(), roads: new Map() };
}

// Cascade every raised cell's neighbourhood down one level per ring until all
// reach level 0 (the gen_mars_base "terraced skirt" so no skirt hangs over
// void). Optional — assemblies that sit ON a base plate don't need it.
function cascadeToZero(f: Feature, n: number): void {
  const ALL8 = [...DIRS, ...DIAGS];
  for (;;) {
    const add = new Map<string, number>();
    for (const [key, level] of f.level) {
      if (level <= 0) continue;
      const [x, z] = key.split(",").map(Number);
      for (const [dx, dz] of ALL8) {
        const c = `${x + dx},${z + dz}`;
        const cx = x + dx, cz = z + dz;
        if (!f.level.has(c) && cx >= 0 && cx < n && cz >= 0 && cz < n) {
          add.set(c, Math.max(add.get(c) ?? -99, level - 1));
        }
      }
    }
    if (add.size === 0) break;
    for (const [k, v] of add) f.level.set(k, v);
  }
}

function mapJson(cells: CellDef[], origin: [number, number, number]): MapJson {
  return { meta: { tile_size: 1, level_height: 0.5, origin_offset: origin }, cells };
}

// ── Scene boilerplate (orbit camera, sprite labels) ─────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b1a);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(6, 10, 4);
scene.add(dir);

let camTarget = new THREE.Vector3(0, 0, 0);
let yaw = 0.6, pitch = 0.7, dist = 34;
function place(): void {
  camera.position.set(
    camTarget.x + dist * Math.cos(pitch) * Math.sin(yaw),
    camTarget.y + dist * Math.sin(pitch),
    camTarget.z + dist * Math.cos(pitch) * Math.cos(yaw),
  );
  camera.lookAt(camTarget);
}
let drag = false, px = 0, py = 0;
addEventListener("mousedown", e => { drag = true; px = e.clientX; py = e.clientY; });
addEventListener("mouseup", () => { drag = false; });
addEventListener("mousemove", e => {
  if (!drag) return;
  yaw -= (e.clientX - px) * 0.005;
  pitch = Math.max(0.05, Math.min(1.5, pitch + (e.clientY - py) * 0.005));
  px = e.clientX; py = e.clientY; place();
});
addEventListener("wheel", e => { dist = Math.max(4, Math.min(140, dist + e.deltaY * 0.02)); place(); });
addEventListener("keydown", e => {
  const step = 2;
  if (e.key === "ArrowLeft" || e.key === "a") camTarget.x -= step;
  else if (e.key === "ArrowRight" || e.key === "d") camTarget.x += step;
  else if (e.key === "ArrowUp" || e.key === "w") camTarget.z -= step;
  else if (e.key === "ArrowDown" || e.key === "s") camTarget.z += step;
  else return;
  place();
});

function label(text: string, x: number, y: number, z: number, color = "#ffd54a"): void {
  const cvs = document.createElement("canvas");
  cvs.width = 512; cvs.height = 64;
  const ctx = cvs.getContext("2d")!;
  ctx.fillStyle = color; ctx.font = "26px monospace"; ctx.textAlign = "center";
  ctx.fillText(text, 256, 42);
  const tex = new THREE.CanvasTexture(cvs);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.position.set(x, y, z); spr.scale.set(6, 0.75, 1);
  scene.add(spr);
}

(async () => {
  const lib = await loadAssetLibrary(ASSETS);
  const built: Record<string, GameMap> = {};
  const cellsByName: Record<string, CellDef[]> = {};

  // Place an assembly's GameMap group at a world offset, add a title label.
  function show(name: string, cells: CellDef[], ox: number, oz: number, title: string): void {
    const gm = GameMap.fromJson(mapJson(cells, [ox, 0, oz]), lib);
    scene.add(gm.root);
    built[name] = gm;
    cellsByName[name] = cells;
    label(title, ox, 3.2, oz - 3, "#7fffd4");
  }

  // ── 1. Canonical square plateau (gen_mars_base recipe) — the corner test ──
  // 4×4 plateau at level 1 sitting on a level-0 base plate one ring wider.
  // Skirt auto-derived; watch the 4 convex corners for the notch.
  {
    const f = newFeature();
    fillRect(f, -3, 3, -3, 3, 0);   // base plate lvl 0
    fillRect(f, -1, 1, -1, 1, 1);   // raised plateau lvl 1
    show("plateau", classify(f), -12, 0, "1) PLATO lvl1 + skirt (corner test)");
  }

  // ── 2. Ridge you drive OVER: ramp up one face, ramp down the other ───────
  // Level-0 apron, a 3-wide lvl-1 bar across the middle, ramps on the ±X faces
  // so a kart drives up +X and down the far side. THIS is the driveable slope
  // Dima meant ("дорога в гору = обычный склон = ramp, не sideCorner"). The
  // apron wraps z=-2..2 so the ridge's ±Z faces skirt onto ground (no open
  // edge hanging over void).
  {
    const f = newFeature();
    fillRect(f, -3, 3, -2, 2, 0);   // apron lvl 0
    fillRect(f, -1, 1, -1, 1, 1);   // ridge top lvl 1
    f.ramps.set("-2,-1", 90); f.ramps.set("-2,0", 90); f.ramps.set("-2,1", 90); // west ramp ascends +X
    f.ramps.set("2,-1", 270); f.ramps.set("2,0", 270); f.ramps.set("2,1", 270); // east ramp ascends -X
    show("ridge", classify(f), 0, 0, "2) RIDGE ramp up/down (driveable)");
  }

  // ── 3. Mountain with a ROAD up: 2-tier mesa + ramp climbing both tiers ────
  // This is the reference "дорога в гору + гора на горе": a level-0 base, a
  // level-1 tier, a level-2 tier on top, and a ramp road climbing south→north
  // straight up both steps (drive from ground onto tier1, keep going onto
  // tier2). Skirts wrap every other edge.
  {
    const f = newFeature();
    fillRect(f, -4, 4, -4, 4, 0);   // base lvl 0
    fillRect(f, -3, 3, -3, 3, 1);   // tier 1
    fillRect(f, -1, 1, -1, 1, 2);   // tier 2 (summit)
    f.ramps.set("0,-4", 0);         // ground → tier1 (ascend +Z onto (0,-3))
    f.ramps.set("0,-2", 0);         // tier1 → tier2 (ascend +Z onto (0,-1))
    show("mountainRoad", classify(f), 13, 0, "3) MOUNTAIN + road up (ramp climbs 2 tiers)");
  }

  // ── 4. side vs ramp descent, side by side (the difference, visualized) ───
  {
    const fS = newFeature();
    fillRect(fS, -2, 2, -1, 1, 0);
    fillRect(fS, 0, 2, -1, 1, 1);   // step whose -X face gets a `side`
    show("descentSide", classify(fS), -12, 12, "4a) SIDE = steep drop (skirt)");

    const fR = newFeature();
    fillRect(fR, -2, 2, -1, 1, 0);
    fillRect(fR, 0, 2, -1, 1, 1);
    fR.ramps.set("-1,-1", 90); fR.ramps.set("-1,0", 90); fR.ramps.set("-1,1", 90); // ramp up +X
    show("descentRamp", classify(fR), 0, 12, "4b) RAMP = driveable slope");
  }

  // Grid + axes so +X (red) / +Z (blue) are unambiguous while inspecting.
  const grid = new THREE.GridHelper(80, 80, 0x334, 0x223);
  scene.add(grid);
  scene.add(new THREE.AxesHelper(4));

  camTarget.set(-6, 0, 4);
  place();
  (window as unknown as Record<string, unknown>).__asm = { lib, built, cellsByName, scene, camera };
  (window as unknown as Record<string, unknown>).__ready = true;
  (document.getElementById("info") as HTMLElement).textContent =
    "Assemblies loaded. Drag=orbit, wheel=zoom, WASD/arrows=pan. window.__asm exposes GameMaps.";
})();

renderer.setAnimationLoop(() => renderer.render(scene, camera));
