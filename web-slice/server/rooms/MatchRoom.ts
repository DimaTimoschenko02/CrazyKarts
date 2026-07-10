// Owner-authoritative position relay (movement) + fully server-authoritative
// combat (weapons/damage/death/respawn/pickups), per docs/p2-port-notes.md
// §1-3. Movement stays owner-authoritative: each client simulates its own
// kart locally (src/physics/, untouched) and reports pose at ~20Hz; the
// server only validates and mirrors it. Everything about combat — firing,
// hit detection, damage, death, respawn point selection, weapon-box pickup —
// is decided here and only here; clients render what the server tells them.
import { Client, Room } from "colyseus";
import { MatchState, Player, WeaponBox } from "../schema/MatchState";
import { loadArena, type Arena, type WorldPoint } from "../config/arena";
import { isBoxPickupInRange } from "./pickupRange";
import { faceCenterYaw, pickInitialSpawn, pickRespawnSpawn } from "../spawn/spawnSelect";
import { WEAPON_TYPES, type DynamiteStats, type MineStats, type ProjectileStats } from "../../src/weapons/stats";
import {
  computeAoeDamage,
  computeLaunchPitchRad,
  computeMuzzleDirections,
  findProximityHit,
  stepRocket,
  tiltDirection3D,
  type PlayerPoint,
} from "../weapons/rocketSim";
import { isMineArmed, isMineExpired, MINE_DROP_BACK_OFFSET_M, MINE_DROP_INTERVAL_S } from "../weapons/mineSim";
import {
  chargeFraction,
  clampHoldMs,
  computeLaunchDir3D,
  computeLaunchSpeed,
  dynamitePositionAtT,
} from "../weapons/dynamiteSim";
import { sweepProjectileSegment } from "../weapons/projectileSweep";

const ROCKET = WEAPON_TYPES.rocket as ProjectileStats;
const MINES = WEAPON_TYPES.mines as MineStats;
const DYNAMITE = WEAPON_TYPES.dynamite as DynamiteStats;

// Pickup pool for weapon boxes (task spec 2026-07-10: "Боксы: подбор теперь
// даёт СЛУЧАЙНОЕ из [rocket, mines, dynamite]"). No weights — uniform
// random, same simplicity as the single-prize reference this replaces.
const WEAPON_POOL = ["rocket", "mines", "dynamite"] as const;
function pickRandomWeapon(): string {
  return WEAPON_POOL[Math.floor(Math.random() * WEAPON_POOL.length)];
}

// Layer-aware ground sampling for a dropped mine (shared/heightfield.ts
// Heightfield.sampleAt) — same "which floor is this body near" convention
// rocketSim.ts's computeLaunchPitchRad uses (0.8 = KartPhysicsParams.
// layerClimbThreshold's design default), kept as a local literal for the
// same reason rocketSim.ts does: this module has no other dependency on
// kart tuning.
const MINE_GROUND_LAYER_CLIMB_THRESHOLD = 0.8;

const MAX_COORD = 1000; // sanity bound — well outside any real arena extent

// UNCONFIRMED vs the Godot .tscn Area3D pickup shape (not read this session,
// see docs/p2-port-notes.md §2 TODO) — tune by feel, not a spec value.
const BOX_PICKUP_RADIUS_M = 1.2;
const BOX_RESPAWN_MS = 10_000; // scripts/weapon_pickup.gd:3 RESPAWN_TIME — this one IS confirmed
const BOX_HOVER_HEIGHT_M = 0.5; // cosmetic only — how high the box floats above the ground for rendering
// Vertical pickup gate (see pickupRange.ts): karts are ~1m tall, boxes hover
// BOX_HOVER_HEIGHT_M above their authored/ground Y, so 1.6 comfortably
// covers "same floor" contact while still rejecting a kart driving UNDER a
// bridge that has a box sitting on its deck (the bug this constant fixes —
// tickBoxes used to be pure XZ distance, so it couldn't tell those apart).
const BOX_PICKUP_VERTICAL_M = 1.6;

const DEATH_RESPAWN_DELAY_MS = 3_000; // state_manager.gd:13 RESPAWN_DELAY (confirmed)
const RESPAWN_INVULN_MS = 2_000; // state_manager.gd:14 RESPAWN_INVULN_DURATION (confirmed)

// Match timer (docs/p2-port-notes.md §4). The Express lobby already validates
// a duration_min whitelist (server/rooms/rooms.constants.js DURATION_MIN_OPTIONS
// = [5, 10, 20]) and defaults new rooms to 5 — this Colyseus room isn't wired
// to that lobby yet (no options plumbed through matchMaker), so it always uses
// that same 5-minute default for now. MATCH_DURATION_MS env override exists
// only so tools/match_flow_smoke.mjs can run a match end-to-end in seconds
// instead of minutes; it's not meant to be set in production.
const DEFAULT_MATCH_DURATION_MS = 5 * 60_000;
const MATCH_DURATION_MS = Number.parseInt(process.env.MATCH_DURATION_MS ?? "", 10) || DEFAULT_MATCH_DURATION_MS;
const MATCH_RESTART_DELAY_MS = 15_000;

// UNCONFIRMED vs the Godot muzzle socket offsets (kart_controller.gd sockets
// carry their own local transform we don't have — our race.glb model
// (kart/stats.ts KART_TYPES.racer, formerly craft_racer) has no launcher
// meshes at all, see src/weapons/stats.ts volleyCount comment). Tune by feel.
// Also reused as the dynamite throw origin (task spec doesn't call for a
// separate offset — thrown from the same "muzzle" point a rocket launches
// from keeps every projectile's spawn point consistent).
const MUZZLE_FORWARD_OFFSET_M = 1.2;
const MUZZLE_HEIGHT_OFFSET_M = 0.5;

const ROCKET_SIM_HZ = 30;

interface StateMessage {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// Rate-limited anomaly logging: a bad/hostile client sending garbage every
// tick must not flood the server log.
const ANOMALY_LOG_INTERVAL_MS = 2000;
let lastAnomalyLogAt = 0;

function logAnomaly(sessionId: string, reason: string): void {
  const now = Date.now();
  if (now - lastAnomalyLogAt < ANOMALY_LOG_INTERVAL_MS) return;
  lastAnomalyLogAt = now;
  console.warn(`[match] rejected state from ${sessionId}: ${reason}`);
}

function isValidNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Never trust the client: every field must be a finite number within
// plausible map bounds before it's allowed to touch shared state.
function validateStateMessage(data: unknown, sessionId: string): StateMessage | null {
  if (typeof data !== "object" || data === null) {
    logAnomaly(sessionId, "payload not an object");
    return null;
  }
  const d = data as Record<string, unknown>;
  if (!isValidNumber(d.x) || !isValidNumber(d.y) || !isValidNumber(d.z) || !isValidNumber(d.yaw)) {
    logAnomaly(sessionId, "non-finite or missing x/y/z/yaw");
    return null;
  }
  if (Math.abs(d.x) > MAX_COORD || Math.abs(d.y) > MAX_COORD || Math.abs(d.z) > MAX_COORD) {
    logAnomaly(sessionId, "coordinate out of bounds");
    return null;
  }
  return { x: d.x, y: d.y, z: d.z, yaw: d.yaw };
}

// Server-only bookkeeping for an in-flight rocket — never mirrored into
// MatchState (see file header on the broadcast-vs-schema decision for
// projectiles: deterministic straight-line motion means the client can
// render it analytically from a single "rocket:spawn" message).
interface ActiveRocket {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  dx: number; // 3D unit direction — no longer horizontal-only, see
  dy: number; // computeLaunchPitchRad/tiltDirection3D in rocketSim.ts. Still
  dz: number; // gravityScale=0: the tilt is fixed once at launch, not re-aimed.
  speed: number;
  age: number;
  lifetime: number;
}

// A mine dropped and sitting on the ground. Not mirrored into MatchState —
// same "server broadcasts events, client renders them" pattern as rockets
// (see ActiveRocket doc above); a mine doesn't move once dropped, so there's
// nothing for the client to interpolate anyway.
interface ActiveMine {
  id: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  age: number; // seconds since drop
}

// A dynamite in flight or stuck. Flight position is recomputed each tick
// from the closed-form parabola (dynamiteSim.ts dynamitePositionAtT) rather
// than integrated incrementally — see that function's doc comment for why.
interface ActiveDynamite {
  id: string;
  ownerId: string;
  origin: { x: number; y: number; z: number };
  vel0: { x: number; y: number; z: number };
  age: number; // seconds since launch — frozen once stuck
  x: number;
  y: number;
  z: number;
  stuck: boolean;
  stuckToId: string | null; // set only if it stuck to a kart, not the ground
  fuseAge: number; // seconds since sticking — only advances once stuck
}

// Colyseus defaults patchRate to 50ms (20Hz, see @colyseus/core Room.ts
// DEFAULT_PATCH_RATE) — slower than the 30Hz (~33ms) cadence clients already
// send "state" at (netClient.ts SEND_INTERVAL_MS), so schema mutations from
// handleState() below could sit queued for up to 50ms before the next patch
// broadcast even though they were applied to the schema instantly. Matching
// the two rates removes that dead time from the movement-relay latency
// budget without changing anything about WHAT gets sent, only how often the
// server flushes it — a simulation/transport setting, not game logic.
const PATCH_RATE_MS = 1000 / 30;

interface RoomCreateOptions {
  // Which map this room's arena is built from — see server/config/arena.ts
  // loadArena() for name validation/fallback. Only the FIRST joinOrCreate()
  // call that actually creates this room (see server/index.ts filterBy(
  // ["code"]) — same `code` routes subsequent joiners into this same room
  // instance) has its `map` honored: onJoin() below never reads
  // options.map, so a later joiner passing a different map is silently
  // ignored. This mirrors the lobby's own contract (src/lobby/main.ts) —
  // whoever creates the invite link picks the arena everyone plays on.
  map?: string;
}

export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 8;
  patchRate = PATCH_RATE_MS;

  private arena!: Arena;
  private rockets: ActiveRocket[] = [];
  private mines: ActiveMine[] = [];
  private dynamites: ActiveDynamite[] = [];
  private nextRocketId = 0;
  private nextMineId = 0;
  private nextDynamiteId = 0;
  private spawnIndex = 0;
  // Respawn invulnerability window, keyed by sessionId — server-only, not
  // mirrored to schema (no shield VFX in this pass, just damage immunity).
  private invulnerableUntil = new Map<string, number>();

  onCreate(options?: RoomCreateOptions): void {
    this.arena = loadArena(options?.map);
    this.setState(new MatchState());

    this.arena.boxPoints.forEach((p, i) => {
      const box = new WeaponBox();
      box.x = p.x;
      box.z = p.z;
      // p.y is already the authored/ground-derived resting height (see
      // arena.ts BoxPoint doc) — for hand-authored box_points this is
      // y_level*level_height AS-IS (may legitimately be mid-air, e.g. a
      // bridge deck), so this must NOT be re-derived from groundHeightAt(p)
      // here like it used to be, which silently discarded that authored
      // height and dropped every airborne box onto the terrain below it.
      box.y = p.y + BOX_HOVER_HEIGHT_M;
      box.active = true;
      this.state.boxes.set(String(i), box);
    });

    this.onMessage("state", (client, data: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return; // message arrived after leave/before join settled
      if (!player.alive) return; // corpses don't move (extra safety net — a
      // well-behaved client already stops reporting while dead, see
      // src/combat/index.ts, but a buggy/compromised one must not be able to
      // relocate a dead kart through the state channel).
      const validated = validateStateMessage(data, client.sessionId);
      if (!validated) return;
      player.x = validated.x;
      player.y = validated.y;
      player.z = validated.z;
      player.yaw = validated.yaw;
    });

    // `data` only matters for dynamite (holdMs) — rocket/mines ignore it.
    // Never trust it: handleFire re-validates/clamps everything itself.
    this.onMessage("fire", (client, data: unknown) => this.handleFire(client, data));

    this.setSimulationInterval(dt => this.tick(dt), 1000 / ROCKET_SIM_HZ);

    // TODO: start the clock on first join / lobby "ready" signal instead of
    // room creation — deferred until the Express lobby actually creates this
    // room with player-controlled timing. For now (MVP) the timer starts the
    // instant the room object exists, same as everything else in onCreate().
    this.state.phase = "playing";
    this.startMatchTimer();
  }

  onJoin(client: Client, options?: { nick?: string; kartType?: string }): void {
    const player = new Player();
    const spawn = pickInitialSpawn(this.arena.spawnPoints, this.spawnIndex++);
    player.x = spawn.x;
    player.y = this.arena.groundHeightAt(spawn);
    player.z = spawn.z;
    player.yaw = faceCenterYaw(spawn);
    player.nick = options?.nick?.slice(0, 24) || "guest";
    player.kartType = options?.kartType === "racer" ? "racer" : "racer"; // only one kart type exists today
    player.hp = 100;
    player.alive = true;
    player.weapon = "";
    this.state.players.set(client.sessionId, player);
    console.log(`[match] ${client.sessionId} joined as "${player.nick}" (${this.state.players.size}/${this.maxClients})`);
  }

  onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.invulnerableUntil.delete(client.sessionId);
    console.log(`[match] ${client.sessionId} left (${this.state.players.size}/${this.maxClients})`);
  }

  // ── Match timer / end / restart ──────────────────────────────────────
  private startMatchTimer(): void {
    this.state.matchEndsAt = Date.now() + MATCH_DURATION_MS;
    this.clock.setTimeout(() => this.endMatch(), MATCH_DURATION_MS);
  }

  // Freezes combat (fire/damage/pickup all check `phase === "playing"`),
  // snapshots the scoreboard for the client's Final Score overlay, and
  // schedules the restart. Doesn't touch player position/hp/weapon here —
  // that reset happens all at once in restartMatch() so a player who died
  // seconds before the whistle doesn't flicker back to life mid-freeze.
  private endMatch(): void {
    this.state.phase = "ended";
    const table = Array.from(this.state.players.entries()).map(([id, p]) => ({
      id,
      nick: p.nick,
      kills: p.kills,
      deaths: p.deaths,
    }));
    const restartAt = Date.now() + MATCH_RESTART_DELAY_MS;
    this.broadcast("match:end", { table, restartAt });
    this.clock.setTimeout(() => this.restartMatch(), MATCH_RESTART_DELAY_MS);
  }

  // Same room, same connections — just wipes stats/hp/weapons and
  // re-scatters everyone across the spawn points (round-robin, same as a
  // fresh join) rather than leaving corpses/mid-match positions lying around.
  // Also clears every live projectile/mine/dynamite (task spec: "чистить все
  // при restartMatch" — unlike death, which deliberately leaves an owner's
  // mines/dynamite alive, a full match restart wipes everything).
  private restartMatch(): void {
    this.rockets = [];
    this.mines = [];
    this.dynamites = [];
    this.invulnerableUntil.clear();
    this.spawnIndex = 0;
    for (const player of this.state.players.values()) {
      const spawn = pickInitialSpawn(this.arena.spawnPoints, this.spawnIndex++);
      player.x = spawn.x;
      player.y = this.arena.groundHeightAt(spawn);
      player.z = spawn.z;
      player.yaw = faceCenterYaw(spawn);
      player.hp = 100;
      player.alive = true;
      player.weapon = "";
      player.kills = 0;
      player.deaths = 0;
    }
    for (const box of this.state.boxes.values()) box.active = true;
    this.state.phase = "playing";
    this.startMatchTimer();
    this.broadcast("match:restart", { matchEndsAt: this.state.matchEndsAt });
  }

  // ── Fire ────────────────────────────────────────────────────────────
  // Dispatches to the weapon-specific fire handler and consumes the ARMED
  // slot up front (ARMED -> EMPTY), same "no ammo counter, no separate
  // cooldown timer" contract every weapon shares — matches the rocket
  // reference (docs/p2-port-notes.md §1) and extends it uniformly to mines/
  // dynamite rather than special-casing consumption per weapon.
  private handleFire(client: Client, data: unknown): void {
    if (this.state.phase !== "playing") return; // fire is disabled during the end-of-match freeze
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (!player.alive || player.weapon === "") return; // can_fire() guard: alive AND armed

    const weapon = player.weapon;
    player.weapon = "";

    switch (weapon) {
      case "rocket":
        this.fireRocket(client, player);
        break;
      case "mines":
        this.fireMines(client);
        break;
      case "dynamite":
        this.fireDynamite(client, player, data);
        break;
      default:
        break; // unknown weapon string — already consumed, nothing to launch
    }
  }

  private fireRocket(client: Client, player: Player): void {
    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const originX = player.x + fwd.x * MUZZLE_FORWARD_OFFSET_M;
    const originZ = player.z + fwd.z * MUZZLE_FORWARD_OFFSET_M;
    const originY = player.y + MUZZLE_HEIGHT_OFFSET_M;

    for (const dir of computeMuzzleDirections(player.yaw, ROCKET)) {
      // Ground-slope-aware pitch: nose the rocket up/down to match the
      // terrain under the shooter (ramps, plateaus) instead of always flying
      // dead level — sampled once at launch, then baked into a fixed 3D
      // direction (gravityScale=0, still a straight line, just tilted).
      // Probed around the KART (player.x/z), NOT the muzzle: the muzzle sits
      // 1.2m ahead, past the edge of a 1m ramp tile — see the regression
      // note on computeLaunchPitchRad in rocketSim.ts.
      const pitch = computeLaunchPitchRad(player.x, player.z, dir.dx, dir.dz, this.arena.heightfield, player.y);
      const dir3d = tiltDirection3D(dir.dx, dir.dz, pitch);

      const id = `r${this.nextRocketId++}`;
      const rocket: ActiveRocket = {
        id,
        ownerId: client.sessionId,
        x: originX,
        y: originY,
        z: originZ,
        dx: dir3d.x,
        dy: dir3d.y,
        dz: dir3d.z,
        speed: ROCKET.speed,
        age: 0,
        lifetime: ROCKET.lifetime,
      };
      this.rockets.push(rocket);
      this.broadcast("rocket:spawn", {
        id,
        ownerId: client.sessionId,
        x: rocket.x,
        y: rocket.y,
        z: rocket.z,
        dx: dir3d.x,
        dy: dir3d.y, // NEW field — additive to the rocket:spawn payload, lets
        // the client extrapolate the same tilted straight line the server
        // simulates instead of assuming flat flight (src/combat/rockets.ts).
        dz: dir3d.z,
        speed: ROCKET.speed,
        lifetime: ROCKET.lifetime,
      });
    }
  }

  // Schedules MINES.count drops, T seconds apart (MINE_DROP_INTERVAL_S —
  // see mineSim.ts for the formula), the first at T=0. Each drop reads the
  // player's CURRENT x/y/z/yaw at the moment it fires (task spec: "Сервер
  // дропает мину в текущей позиции игрока"), not a position frozen at the
  // original fire() call — a player still driving while their mines trickle
  // out lays a trail behind them, not 3 mines stacked on one spot.
  private fireMines(client: Client): void {
    const ownerId = client.sessionId;
    for (let i = 0; i < MINES.count; i++) {
      this.clock.setTimeout(() => this.dropMine(ownerId), i * MINE_DROP_INTERVAL_S * 1000);
    }
  }

  private dropMine(ownerId: string): void {
    if (this.state.phase !== "playing") return; // no new mines during the end-of-match freeze
    const player = this.state.players.get(ownerId);
    if (!player) return; // left the room mid-sequence

    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const dropX = player.x - fwd.x * MINE_DROP_BACK_OFFSET_M;
    const dropZ = player.z - fwd.z * MINE_DROP_BACK_OFFSET_M;
    const dropY =
      this.arena.heightfield.sampleAt(dropX, dropZ, player.y, MINE_GROUND_LAYER_CLIMB_THRESHOLD) ?? player.y;

    const id = `mn${this.nextMineId++}`;
    const mine: ActiveMine = { id, ownerId, x: dropX, y: dropY, z: dropZ, age: 0 };
    this.mines.push(mine);
    this.broadcast("mine:spawn", { id, x: dropX, y: dropY, z: dropZ });
  }

  // Server clamps holdMs itself (dynamiteSim.clampHoldMs) — the client's
  // reported value is only ever a hint, never trusted directly (a modified
  // client could claim any hold length).
  private fireDynamite(client: Client, player: Player, data: unknown): void {
    const rawHoldMs =
      typeof data === "object" && data !== null && isValidNumber((data as Record<string, unknown>).holdMs)
        ? (data as { holdMs: number }).holdMs
        : 0;
    const holdMs = clampHoldMs(rawHoldMs, DYNAMITE.maxChargeMs);
    const charge = chargeFraction(holdMs, DYNAMITE.maxChargeMs);
    const speed = computeLaunchSpeed(charge, DYNAMITE.speedMin, DYNAMITE.speedMax);
    const dir3d = computeLaunchDir3D(player.yaw, DYNAMITE.launchAngleDeg);
    const vel0 = { x: dir3d.x * speed, y: dir3d.y * speed, z: dir3d.z * speed };

    // Same throw origin as a rocket's muzzle (MUZZLE_FORWARD_OFFSET_M/
    // MUZZLE_HEIGHT_OFFSET_M) — see that constant's doc comment.
    const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
    const origin = {
      x: player.x + fwd.x * MUZZLE_FORWARD_OFFSET_M,
      y: player.y + MUZZLE_HEIGHT_OFFSET_M,
      z: player.z + fwd.z * MUZZLE_FORWARD_OFFSET_M,
    };

    const id = `dy${this.nextDynamiteId++}`;
    const dynamite: ActiveDynamite = {
      id,
      ownerId: client.sessionId,
      origin,
      vel0,
      age: 0,
      x: origin.x,
      y: origin.y,
      z: origin.z,
      stuck: false,
      stuckToId: null,
      fuseAge: 0,
    };
    this.dynamites.push(dynamite);
    this.broadcast("dynamite:spawn", {
      id,
      origin,
      dir3d,
      speed,
      gravity: DYNAMITE.gravity,
    });
  }

  // ── Simulation tick (rockets + mines + dynamite + box pickup) ────────
  private tick(deltaTimeMs: number): void {
    const dt = deltaTimeMs / 1000;
    this.tickRockets(dt);
    this.tickMines(dt);
    this.tickDynamite(dt);
    this.tickBoxes();
  }

  private alivePlayerPoints(): PlayerPoint[] {
    const out: PlayerPoint[] = [];
    for (const [id, p] of this.state.players.entries()) {
      if (p.alive) out.push({ id, x: p.x, y: p.y, z: p.z });
    }
    return out;
  }

  private tickRockets(dt: number): void {
    if (this.rockets.length === 0) return;
    const alive = this.alivePlayerPoints();
    const remaining: ActiveRocket[] = [];

    for (const rocket of this.rockets) {
      // `rocket.x/y/z` still holds the position from the END of the
      // PREVIOUS tick (or the muzzle, on the very first tick) — exactly the
      // segment start sweepProjectileSegment needs. Captured BEFORE we
      // overwrite it below (same pattern as tickDynamite).
      const prevPos = { x: rocket.x, y: rocket.y, z: rocket.z };
      rocket.age += dt;
      const next = stepRocket(prevPos, { x: rocket.dx, y: rocket.dy, z: rocket.dz }, rocket.speed, dt);

      // Swept terrain/deck/prop check first (2026-07-10 owner bug, extended
      // from dynamite same day: "НИКАКОЕ оружие не пролетает сквозь
      // объекты" — a rocket at 40m/s covers ~1.33m per 30Hz tick, even
      // wider than dynamite's ~0.93m, so the old single-end-point
      // isBlockedByTerrain sample tunneled through thin walls just as
      // easily). Walks the WHOLE prevPos→next motion in fine substeps — see
      // projectileSweep.ts's file header for the full breakdown, including
      // why flying steadily UNDER a bridge deck still explodes nothing
      // (own-layer floor rule unchanged from before this fix).
      const swept = sweepProjectileSegment(prevPos, next, this.arena.heightfield, this.arena.colliders);

      // Kart proximity stays a simple radius trigger at the tick's END
      // position (unchanged from before this fix) — checked against `next`
      // like before, only when the swept terrain/prop path is clear: a
      // wall/deck/prop hit partway along the segment wins over a kart the
      // rocket would only have reached at the very end of the tick.
      const hitId = swept ? null : findProximityHit(next, alive, ROCKET.hitRadius, rocket.ownerId, ROCKET.selfDamage);
      const explodePos = swept ? swept.hit : next;
      rocket.x = explodePos.x;
      rocket.y = explodePos.y;
      rocket.z = explodePos.z;

      const expired = rocket.age >= rocket.lifetime;

      if (hitId || swept || expired) {
        this.explodeRocket(rocket, alive);
        continue; // consumed — do not keep simulating
      }
      remaining.push(rocket);
    }
    this.rockets = remaining;
  }

  // Every explosion trigger (proximity hit / terrain / bounds / lifetime)
  // resolves through the same AOE-with-falloff formula — see
  // server/weapons/rocketSim.ts file header for why there's no separate
  // "direct hit" damage amount (matches the reference exactly).
  private explodeRocket(rocket: ActiveRocket, alive: readonly PlayerPoint[]): void {
    this.broadcast("rocket:explode", { id: rocket.id, x: rocket.x, y: rocket.y, z: rocket.z });
    const damage = computeAoeDamage({ x: rocket.x, y: rocket.y, z: rocket.z }, alive, ROCKET, rocket.ownerId);
    for (const [victimId, dmg] of damage) {
      this.applyDamage(victimId, dmg, rocket.ownerId);
    }
  }

  private tickMines(dt: number): void {
    if (this.mines.length === 0) return;
    const alive = this.alivePlayerPoints();
    const remaining: ActiveMine[] = [];

    for (const mine of this.mines) {
      mine.age += dt;

      if (isMineExpired(mine.age, MINES.lifetimeS)) {
        this.broadcast("mine:despawn", { id: mine.id }); // silent — no AOE, no VFX
        continue;
      }

      if (isMineArmed(mine.age, MINES.armDelayS)) {
        // Owner decision 2026-07-10: no weapon self-damages — and a mine
        // that CAN'T hurt its owner must not trigger on them either, or
        // driving over your own mine would waste it for zero damage. Pass
        // MINES.selfDamage (false) as the trigger-eligibility flag so the
        // two rules can never drift apart.
        const hitId = findProximityHit(mine, alive, MINES.triggerRadius, mine.ownerId, MINES.selfDamage);
        if (hitId) {
          this.explodeMine(mine, alive);
          continue;
        }
      }
      remaining.push(mine);
    }
    this.mines = remaining;
  }

  private explodeMine(mine: ActiveMine, alive: readonly PlayerPoint[]): void {
    this.broadcast("mine:explode", { id: mine.id, x: mine.x, y: mine.y, z: mine.z });
    const damage = computeAoeDamage({ x: mine.x, y: mine.y, z: mine.z }, alive, MINES, mine.ownerId);
    for (const [victimId, dmg] of damage) {
      this.applyDamage(victimId, dmg, mine.ownerId);
    }
  }

  private tickDynamite(dt: number): void {
    if (this.dynamites.length === 0) return;
    const alive = this.alivePlayerPoints();
    const remaining: ActiveDynamite[] = [];

    for (const dyn of this.dynamites) {
      if (!dyn.stuck) {
        // `dyn.x/y/z` still holds the position from the END of the PREVIOUS
        // tick (or the launch origin, on the very first tick — see
        // fireDynamite) — exactly the segment start sweepProjectileSegment
        // needs. Captured BEFORE we overwrite it below.
        const prevPos = { x: dyn.x, y: dyn.y, z: dyn.z };
        dyn.age += dt;
        const nextPos = dynamitePositionAtT(dyn.origin, dyn.vel0, DYNAMITE.gravity, dyn.age);

        // Swept terrain/deck/prop check first (2026-07-10 owner bug: "летит
        // сквозь стены/потолок") — walks the WHOLE prevPos→nextPos motion in
        // fine substeps instead of point-sampling only nextPos, so a thin
        // wall/step can no longer be tunneled through between ticks, and a
        // deck/roof reached from below now stops it too. See
        // projectileSweep.ts's file header for the full breakdown of what
        // each of its checks catches (shared with tickRockets below).
        const swept = sweepProjectileSegment(prevPos, nextPos, this.arena.heightfield, this.arena.colliders);

        // Kart proximity stays a simple radius trigger at the tick's END
        // position (unchanged from before this fix) — it's already a
        // generous gate, not a precise geometric test, so it doesn't need
        // the sweep. Only checked when the swept terrain/prop path is clear:
        // "sticks to the FIRST thing it touches" (task spec) — a wall/deck
        // hit partway along the segment wins over a kart the dynamite would
        // only have reached at the very end of the tick.
        // DYNAMITE.selfDamage (false, owner decision 2026-07-10) doubles as
        // the stick-eligibility flag: a throw that can't hurt its owner must
        // not stick to them either (it would just ride along harmlessly and
        // waste the shot).
        const hitId = swept ? null : findProximityHit(nextPos, alive, DYNAMITE.stickRadius, dyn.ownerId, DYNAMITE.selfDamage);
        const stickPos = swept ? swept.hit : nextPos;

        dyn.x = stickPos.x;
        dyn.y = stickPos.y;
        dyn.z = stickPos.z;

        if (swept || hitId) {
          dyn.stuck = true;
          dyn.stuckToId = hitId;
          this.broadcast("dynamite:stick", {
            id: dyn.id,
            x: dyn.x,
            y: dyn.y,
            z: dyn.z,
            ...(hitId ? { stuckToId: hitId } : {}),
          });
        }
      } else {
        if (dyn.stuckToId) {
          // Follows the victim (task spec: "координаты обновлять из позиции
          // жертвы") — both for the AOE center at explosion time AND so the
          // client can render it riding along. If the victim already left
          // the room, keep the last known position frozen rather than
          // erroring.
          const victim = this.state.players.get(dyn.stuckToId);
          if (victim) {
            dyn.x = victim.x;
            dyn.y = victim.y;
            dyn.z = victim.z;
            this.broadcast("dynamite:update", { id: dyn.id, x: dyn.x, y: dyn.y, z: dyn.z });
          }
        }
        dyn.fuseAge += dt;
        if (dyn.fuseAge >= DYNAMITE.fuseS) {
          this.explodeDynamite(dyn, alive);
          continue;
        }
      }
      remaining.push(dyn);
    }
    this.dynamites = remaining;
  }

  private explodeDynamite(dyn: ActiveDynamite, alive: readonly PlayerPoint[]): void {
    this.broadcast("dynamite:explode", { id: dyn.id, x: dyn.x, y: dyn.y, z: dyn.z });
    const damage = computeAoeDamage({ x: dyn.x, y: dyn.y, z: dyn.z }, alive, DYNAMITE, dyn.ownerId);
    for (const [victimId, dmg] of damage) {
      this.applyDamage(victimId, dmg, dyn.ownerId);
    }
  }

  private applyDamage(victimId: string, dmg: number, killerId: string): void {
    if (this.state.phase !== "playing") return; // no damage during the end-of-match freeze
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive) return;
    const invulnUntil = this.invulnerableUntil.get(victimId) ?? 0;
    if (Date.now() < invulnUntil) return; // fresh-respawn immunity window

    victim.hp = Math.max(0, victim.hp - dmg);
    if (victim.hp <= 0) this.killPlayer(victimId, killerId);
  }

  private killPlayer(victimId: string, killerId: string): void {
    const victim = this.state.players.get(victimId);
    if (!victim) return;
    victim.alive = false;
    victim.deaths += 1;
    // Weapon IS cleared on death. The reference Godot code does NOT do this
    // (docs/p2-port-notes.md §1 step 8 flags it as a likely oversight in the
    // original rather than a deliberate design choice) — this is an explicit
    // game-designer deviation from the ported reference: dying always clears
    // whatever weapon you were holding, matching the GDD's stated intent
    // instead of the buggier reference behavior.
    victim.weapon = "";
    if (killerId !== victimId) {
      const killer = this.state.players.get(killerId);
      if (killer) killer.kills += 1;
    }
    this.broadcast("kill", { victimId, killerId });
    this.clock.setTimeout(() => this.respawnPlayer(victimId), DEATH_RESPAWN_DELAY_MS);
    // Mines/dynamite already dropped/thrown by this player are NOT cleared
    // here (task spec: "мины и динамиты владельца НЕ чистить при его
    // смерти") — they keep living/ticking independently; only restartMatch()
    // wipes them.
  }

  private respawnPlayer(sessionId: string): void {
    // Scoreboard-freeze window: the pending 3s respawn timer from a kill just
    // before the whistle can still fire here. Skip it — restartMatch() will
    // bring everyone back (full hp, fresh spawn) all at once shortly anyway,
    // so an early one-off respawn here would just get immediately overwritten.
    if (this.state.phase !== "playing") return;
    const player = this.state.players.get(sessionId);
    if (!player) return; // left the room while dead

    const enemies: WorldPoint[] = [];
    for (const [id, p] of this.state.players.entries()) {
      if (id !== sessionId && p.alive) enemies.push({ x: p.x, z: p.z });
    }
    const spawn = pickRespawnSpawn(this.arena.spawnPoints, enemies);
    const yaw = faceCenterYaw(spawn);

    player.x = spawn.x;
    player.z = spawn.z;
    player.y = this.arena.groundHeightAt(spawn);
    player.yaw = yaw;
    player.hp = 100;
    player.alive = true;

    this.invulnerableUntil.set(sessionId, Date.now() + RESPAWN_INVULN_MS);

    // Movement is owner-authoritative — the "state" messages a client sends
    // are ITS OWN pose. A respawn teleport must be pushed to that one client
    // so it can reset its own locally-simulated kart; other clients simply
    // see the new pose arrive via the next "state" message once the
    // respawned client resumes reporting (schema mirrors that automatically).
    this.clients.getById(sessionId)?.send("respawn", { x: spawn.x, z: spawn.z, yaw });
  }

  // ── Weapon boxes ─────────────────────────────────────────────────────
  private tickBoxes(): void {
    if (this.state.phase !== "playing") return; // no pickups during the end-of-match freeze
    for (const [boxId, box] of this.state.boxes.entries()) {
      if (!box.active) continue;
      for (const player of this.state.players.values()) {
        if (!player.alive || player.weapon !== "") continue; // reference: pickup ignored while already ARMED, no replace-on-pickup
        if (!isBoxPickupInRange(player, box, BOX_PICKUP_RADIUS_M, BOX_PICKUP_VERTICAL_M)) continue;
        player.weapon = pickRandomWeapon();
        box.active = false;
        this.scheduleBoxRespawn(boxId);
        break; // one pickup per box per tick
      }
    }
  }

  private scheduleBoxRespawn(boxId: string): void {
    this.clock.setTimeout(() => {
      const box = this.state.boxes.get(boxId);
      if (!box) return;
      box.active = true;
      // Immediate re-check for someone already parked on the respawn spot —
      // mirrors `_try_give_from_overlaps()` in the reference instead of
      // waiting for the next simulation tick.
      this.tickBoxes();
    }, BOX_RESPAWN_MS);
  }
}
