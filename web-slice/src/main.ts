// P1 vertical slice stand: real bicycle physics + continuous drift driving
// a data-driven kart on a tile map. See kart/kart.ts for the physics wiring
// and design/gdd/kart-physics*.md for the spec this ports.
//
// Physics runs on setInterval with fixed substeps (NOT rAF): Chrome fully
// suspends rAF for occluded windows, which breaks agent-driven testing. See
// core/loop.ts.
import * as THREE from "three";
import { createSpaceSky } from "./fx/sky";
import { loadAssetLibrary } from "./map/assetLoader";
import { GameMap } from "./map/mapLoader";
import { ACTIVE_MAP } from "./shared/activeMap";
import { Kart } from "./kart/kart";
import { KART_TYPES } from "./kart/stats";
import { InputController } from "./core/input";
import { FixedStepLoop } from "./core/loop";
import { ChaseCamera } from "./core/camera";
import { Telemetry } from "./debug/telemetry";
import { InputOverlay } from "./debug/inputOverlay";
import { initParamPanel } from "./debug/paramPanel";
import { initNet } from "./net";
import { createCombat } from "./combat";
import { ASSET_NAMES } from "./shared/mapAssets";

// Single source of truth lives in shared/mapAssets.ts (PALETTE) — the editor
// palette and this preload list are derived from the same data so they can
// never drift apart again (see that module's header comment for why).
const MAP_ASSETS = ASSET_NAMES;

// ── Scene ──────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
// Cosmic-indigo daylight, not near-black: background/fog/backdrop (below)
// and the sky dome's ZENITH/HORIZON (fx/sky.ts) share one coordinated,
// slightly-brightened palette so the horizon reads as one continuous
// gradient rather than a visible seam between "flat clear color" and
// "sky dome shader". Still indigo/violet, not a daytime blue — this is a
// stylized Mars/cosmic backdrop, just no longer almost-black.
scene.background = new THREE.Color(0x23264a);
scene.fog = new THREE.Fog(0x4a3562, 60, 140);
createSpaceSky(scene);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 300);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// HemisphereLight (sky/ground) instead of a flat AmbientLight: it splits
// the fill into a "sky" tint from above and a warm "ground bounce" tint
// from below, so a wall facing away from the sun still reads its shape
// instead of going pure black — a plain AmbientLight is uniform in every
// direction and can't do that. (It also wasn't the fix for the actual
// black-wall bug — see map/assetLoader.ts neutralizeMetalness() for the
// real root cause: a metallic-material bug that ate the sun's diffuse
// contribution entirely regardless of ambient level.)
scene.add(new THREE.HemisphereLight(0x8892cf, 0x6b4a35, 0.9));
// Sun raised to ~70° elevation (was ~61°: atan(40/√(20²+10²))) per owner's
// "выше" ask — steep enough to still rake across vertical walls (a fully
// overhead sun would leave every wall face in its own shadow), shallow
// enough to keep a readable shadow direction on the ground.
// Intensity trimmed 1.2 → 1.0: now that materials aren't force-metallic
// anymore (assetLoader.ts fix), diffuse actually responds to the sun again,
// and 1.2 blew out highlights during review.
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(25, 80, 15); // elevation = atan(80/√(25²+15²)) ≈ 70°
scene.add(sun);

// Backdrop plane far below the map so the void outside the arena reads as
// "space", not as a glitch. The actual driveable ground is the tile map.
// Darker/warmer than the sky background so the void still reads as
// "ground", not "more sky" — but no longer near-black like the old 0x0d0d24.
const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x241c33 })
);
backdrop.rotation.x = -Math.PI / 2;
backdrop.position.y = -2;
scene.add(backdrop);

// Spawn just inside the ring road, south of the plateau, facing -Z (north).
const SPAWN = new THREE.Vector3(0, 0, 6.5);
const stats = KART_TYPES.racer;
const kart = new Kart(scene, stats, SPAWN);

const chaseCamera = new ChaseCamera();
const input = new InputController();
const telemetry = new Telemetry(kart, input);
initParamPanel(kart); // dev tuner overlay, toggled with P — see src/debug/paramPanel.ts
const inputOverlay = new InputOverlay(); // W/A/S/D + SPACE key highlight, for gameplay recordings
const hud = document.getElementById("hud")!;

// Combat wiring (weapons/damage/death/respawn/pickups) — server-authoritative,
// see src/combat/index.ts and server/rooms/MatchRoom.ts. Strictly optional
// like net/ itself: with no server, combat.update() just renders "offline"
// and the fire button is a no-op.
const combat = createCombat(scene, kart);

// Which map this session plays on: `?map=editor` is the LEGACY frozen-
// snapshot preview path (browser-localStorage only, unchanged below, see the
// asset-load IIFE), `?map=editor_drive` is the CURRENT editor Drive path
// (bug fix 2026-07-10 — a real file on disk, public/maps/editor_drive.json,
// written by the editor's btnDrive handler so the Colyseus server sees it
// too and server-side entities like weapon boxes actually spawn; it's still
// resolved as an ordinary named map below, just with a badge), `?map=<name>`
// is the lobby's Create-Room map picker (src/lobby/main.ts) riding along on
// the invite link, and no param at all is the plain default. Resolved once,
// up here, so the SAME name can be handed to both the map loader below and
// initNet() (which forwards it into joinOrCreate — see server/rooms/
// MatchRoom.ts onCreate() for how the server decides the room's actual map).
const MAP_NAME_RE = /^[a-z0-9_-]+$/i;
const rawMapParam = new URLSearchParams(location.search).get("map");
const isEditorSnapshot = rawMapParam === "editor"; // legacy localStorage-only fallback path
const isDriveSnapshot = rawMapParam === "editor_drive"; // current disk-backed Drive path — still badge-worthy
let mapName = ACTIVE_MAP;
if (rawMapParam && !isEditorSnapshot) {
  if (MAP_NAME_RE.test(rawMapParam)) {
    mapName = rawMapParam;
  } else {
    console.warn(`[boot] invalid ?map= value "${rawMapParam}" — falling back to "${ACTIVE_MAP}"`);
  }
}

// Multiplayer skeleton: owner-authoritative, strictly optional (see net/).
// Runs its own connect/send/interpolate lifecycle — nothing else in this
// file ever touches net/ internals again after this call except to pass
// net.client into combat.update() and net.getObstacles() into kart.update()
// each frame.
const net = initNet({
  scene,
  getLocalState: () => ({ x: kart.position.x, y: kart.position.y, z: kart.position.z, yaw: kart.yaw }),
  combat: combat.netCallbacks,
  map: mapName,
});

// Corner badge shown when driving an editor Drive snapshot — either the
// current disk-backed path (?map=editor_drive) or the legacy localStorage-
// only fallback (?map=editor) — so a stale/frozen Drive run can't be
// mistaken for the live disk map (see editor Drive handler). Reads
// editor-drive-meta {name, ts} stamped at Drive time.
function showEditorSnapshotBadge(): void {
  let name = "unsaved", ageMin = 0;
  try {
    const meta = JSON.parse(localStorage.getItem("editor-drive-meta") ?? "{}");
    if (typeof meta.name === "string") name = meta.name;
    if (typeof meta.ts === "number") ageMin = Math.round((Date.now() - meta.ts) / 60000);
  } catch { /* no/old meta — show generic badge */ }
  const el = document.createElement("div");
  el.textContent = `⚠ EDITOR SNAPSHOT · ${name} · ${ageMin}m ago (not the live map)`;
  el.style.cssText = "position:fixed;bottom:8px;left:8px;z-index:50;padding:4px 9px;"
    + "font:12px/1.4 monospace;color:#0a0a1a;background:#ffd54a;border-radius:5px;opacity:0.92;";
  document.body.appendChild(el);
}

// Map + kart model load async: physics runs from frame one on a flat
// fallback (height 0) and switches to the map heightfield when it arrives.
// __ready flips only after everything is in — agent-driven tests wait on it.
let map: GameMap | null = null;
(async () => {
  try {
    const lib = await loadAssetLibrary(MAP_ASSETS);
    // Editor hand-off: /?map=editor + a map JSON stashed in localStorage by
    // the "Drive" button in the browser map editor (see src/editor/main.ts).
    const driveJson = isEditorSnapshot ? localStorage.getItem("editor-drive-map") : null;
    if (driveJson) {
      map = GameMap.fromJson(JSON.parse(driveJson), lib);
      showEditorSnapshotBadge(); // this is a FROZEN editor snapshot, not the live disk map — make that unmissable
    } else {
      try {
        map = await GameMap.load(`/maps/${mapName}.json`, lib);
        // editor_drive is a real map file, but still a Drive-authored
        // scratch snapshot (overwritten on every click, not something the
        // owner saved under its own name) — badge it the same as the legacy
        // localStorage path so it's never mistaken for a "real" saved map.
        if (isDriveSnapshot) showEditorSnapshotBadge();
      } catch (e) {
        console.warn(`[boot] failed to load map "${mapName}", falling back to "${ACTIVE_MAP}"`, e);
        map = await GameMap.load(`/maps/${ACTIVE_MAP}.json`, lib);
      }
    }
    scene.add(map.root);
    // The authored SPAWN constant only matches the shipped ACTIVE_MAP layout
    // — a different map (server-picked ?map=, editor Drive snapshot) may
    // have no cell there at all, which reads to the mover as an off-map
    // wall (see kart.ts step 8) and drops the kart into the void. Detect
    // that BEFORE the first physics tick and re-anchor to a walkable cell
    // near the map's own center instead (GameMap.findFallbackSpawn()).
    const spawnGround = map.sampleHeight(SPAWN.x, SPAWN.z);
    if (spawnGround === null) {
      const fallback = map.findFallbackSpawn();
      if (fallback) {
        console.warn(`[boot] SPAWN (${SPAWN.x}, ${SPAWN.z}) is off "${mapName}" — falling back to (${fallback.x}, ${fallback.z})`);
        kart.respawnAt(new THREE.Vector3(fallback.x, fallback.y, fallback.z));
      } else {
        console.warn(`[boot] "${mapName}" has no walkable cells at all — driving on the fallback plane`);
      }
    } else {
      // Re-anchor the spawn's Y to the map's actual ground (top layer, same
      // convention as the server's groundHeightAt). SPAWN's authored y=0 is
      // map-agnostic; starting even slightly BELOW the floor makes the very
      // first vertical step read as a violent ground rise and fires the
      // trampoline rate-detector — a ballistic launch straight off spawn.
      kart.respawnAt(new THREE.Vector3(SPAWN.x, spawnGround, SPAWN.z));
    }
    telemetry.setMapHandles(map, scene);
    net.setMap(map); // remote-kart body tilt (src/net/remoteKarts.ts) needs the heightfield too
    await kart.loadModel(stats.model, stats.modelLength);
  } catch (e) {
    console.error("[boot] asset load failed, driving on the fallback plane", e);
  }
  telemetry.markReady();
})();

// ── Main loop ──────────────────────────────────────────────────────────
const PHYS_STEP = 1 / 120;
const MAX_CATCHUP = 1.1; // never simulate more than ~1s per tick
const loop = new FixedStepLoop(PHYS_STEP, MAX_CATCHUP);

// Physics ticks on setInterval, NOT rAF (see file header). rAF renders only.
// lastRawInput feeds the input overlay once per rendered frame below — it's
// deliberately updated per-substep but only READ once per frame, so the
// overlay shows the most recent input without re-driving physics itself.
let lastRawInput = { throttle: 0, steer: 0 };
function physTick(): void {
  loop.tick(dt => {
    const raw = input.next(dt * 1000);
    // Static map props (rocks, buildings, wall_block*) are resolved via the
    // SAT static-poly path now (Kart.update() step 8b reads map.
    // getStaticColliders() directly) — see design/notes/collision-v2.md.
    // `obstacles` here is only OTHER PLAYERS' karts (kart-vs-kart push
    // circle, physics/kartCollision.ts — unchanged by that rework).
    kart.update(dt, raw, map, net.getObstacles());
    telemetry.recordSubstep(dt, raw);
    lastRawInput = raw;
  });
}
setInterval(physTick, 50);

let lastFrameMs = performance.now();
function frame(): void {
  requestAnimationFrame(frame);
  physTick(); // keep input latency low when rAF is alive
  kart.syncVisual();
  const now = performance.now();
  // Real per-frame dt (not physics' fixed substep) — the camera only runs
  // once per rendered frame, so it needs actual frame time for its
  // framerate-independent follow filter (see camera.ts). Clamped so a
  // tab-backgrounding stall doesn't feed the exp-follow a huge dt and snap
  // the camera across the map on the next visible frame.
  const frameDt = Math.min((now - lastFrameMs) / 1000, 0.1);
  chaseCamera.update(camera, kart.position, kart.yaw, kart.velocity, kart.physicsParams, frameDt);
  telemetry.updateHud(hud);
  inputOverlay.update(lastRawInput);
  combat.update(net.client, input, frameDt); // dt: box spin visual only
  lastFrameMs = now;
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
// __ready is set by the async asset-loading IIFE above.
