// Thin combat wiring — keeps main.ts to a single createCombat() call plus
// one update() call per frame. Owns: fire input -> network (instant weapons
// rocket/mines, plus dynamite's charge-and-throw), rocket/mine/dynamite/
// explosion rendering, weapon-box rendering, HUD (hp/weapon/kills/deaths +
// charge bar + respawn overlay + kill feed), and the local kart's
// visibility/teleport on death/respawn. See docs/p2-port-notes.md §1-3 for
// the rocket design this ports, the 2026-07-10 task brief for mines/
// dynamite, and server/rooms/MatchRoom.ts for the authoritative side — this
// module never decides game rules, it only renders what the server says
// happened and forwards the local player's fire input.
import * as THREE from "three";
import type { Kart } from "../kart/kart";
import type { InputController } from "../core/input";
import type { NetCallbacks, NetClient } from "../net/netClient";
import { WEAPON_TYPES, type DynamiteStats } from "../weapons/stats";
import { RocketManager } from "./rockets";
import { MineManager } from "./mines";
import { DynamiteManager } from "./dynamite";
import { BoxManager } from "./boxes";
import { CombatHud } from "./hud";
import { FinalScoreOverlay } from "./finalScore";
import { mountPauseMenu } from "../ui/pauseMenu";

const DYNAMITE = WEAPON_TYPES.dynamite as DynamiteStats;

export type CombatNetCallbacks = Pick<
  NetCallbacks,
  | "onRocketSpawn"
  | "onRocketExplode"
  | "onMineSpawn"
  | "onMineExplode"
  | "onMineDespawn"
  | "onDynamiteSpawn"
  | "onDynamiteStick"
  | "onDynamiteUpdate"
  | "onDynamiteExplode"
  | "onKill"
  | "onRespawn"
  | "onMatchEnd"
  | "onMatchRestart"
>;

export interface CombatHandle {
  // Passed into NetClient.connect() (via initNet's InitNetOptions) alongside
  // the movement-relay callbacks — see main.ts wiring.
  netCallbacks: CombatNetCallbacks;
  // Call once per rendered frame, after the kart/camera update for that frame.
  update(client: NetClient, input: InputController, dt: number): void;
}

export function createCombat(scene: THREE.Scene, kart: Kart): CombatHandle {
  const rockets = new RocketManager(scene);
  const mines = new MineManager(scene);
  const dynamite = new DynamiteManager(scene);
  const boxes = new BoxManager(scene);
  const hud = CombatHud.mount();
  const finalScore = FinalScoreOverlay.mount();
  // Pause menu has no per-frame update — it's pure event-driven DOM (its own
  // keydown/click listeners), so mounting it here is a fire-and-forget call,
  // same shape as CombatHud.mount()/FinalScoreOverlay.mount() but with
  // nothing to hold onto afterward.
  mountPauseMenu();

  const netCallbacks: CombatNetCallbacks = {
    onRocketSpawn: msg => rockets.spawn(msg),
    onRocketExplode: msg => rockets.explode(msg),
    onMineSpawn: msg => mines.spawn(msg),
    onMineExplode: msg => mines.explode(msg),
    onMineDespawn: msg => mines.despawn(msg),
    onDynamiteSpawn: msg => dynamite.spawn(msg),
    onDynamiteStick: msg => dynamite.stick(msg),
    onDynamiteUpdate: msg => dynamite.followUpdate(msg),
    onDynamiteExplode: msg => dynamite.explode(msg),
    onKill: msg => hud.pushKillFeed(msg),
    // Movement is owner-authoritative (see net/netClient.ts) — the server
    // can't just patch our own schema pose to move us, it has to explicitly
    // tell THIS client to teleport its locally-simulated kart.
    onRespawn: msg => kart.teleport(msg.x, msg.z, msg.yaw),
    onMatchEnd: msg => finalScore.show(msg.table, msg.restartAt),
    onMatchRestart: () => finalScore.hide(),
  };

  // Dynamite charge state — performance.now() timestamp of the press that
  // started the current charge, or null while not charging. Lives here (not
  // InputController) because it's weapon-aware: only holding "dynamite"
  // turns a press into a hold-and-charge, every other weapon stays the old
  // instant-fire-on-press behavior.
  let dynamiteChargeStartAt: number | null = null;

  return {
    netCallbacks,
    update(client, input, dt) {
      const self = client.getSelf();
      hud.updateStats(self);
      hud.updateTimer(client.getMatchEndsAt());
      // Offline / not-yet-joined: self is null, always render the kart.
      kart.group.visible = self ? self.alive : true;

      // Dying mid-charge cancels the throw locally (nothing was sent yet) —
      // the server would ignore a fire() from a dead player anyway (see
      // MatchRoom.handleFire's alive guard), this just keeps the charge bar
      // from being stuck on-screen over a corpse.
      if (dynamiteChargeStartAt !== null && self && !self.alive) {
        dynamiteChargeStartAt = null;
        hud.updateCharge(null);
      }

      const weapon = self?.weapon ?? "";
      if (weapon === "dynamite") {
        if (input.consumeFire() && (!self || self.alive)) {
          dynamiteChargeStartAt = performance.now();
        }
        if (dynamiteChargeStartAt !== null) {
          const heldMs = performance.now() - dynamiteChargeStartAt;
          const released = input.consumeFireRelease();
          // Auto-throws at the cap even without a release edge (task spec:
          // "При достижении maxChargeMs клиент бросает АВТОМАТИЧЕСКИ") — the
          // server clamps holdMs itself regardless (dynamiteSim.clampHoldMs
          // is authoritative), this just means the player doesn't have to
          // let go for the max-charge throw to actually happen.
          if (released || heldMs >= DYNAMITE.maxChargeMs) {
            client.sendFire(Math.min(heldMs, DYNAMITE.maxChargeMs));
            dynamiteChargeStartAt = null;
            hud.updateCharge(null);
          } else {
            hud.updateCharge(heldMs / DYNAMITE.maxChargeMs);
          }
        } else {
          input.consumeFireRelease(); // drop a stray release edge (e.g. picked up dynamite mid-press)
          hud.updateCharge(null);
        }
      } else {
        dynamiteChargeStartAt = null;
        hud.updateCharge(null);
        input.consumeFireRelease(); // drop any pending release edge left over from a weapon switch

        // Edge-triggered regardless of alive state (so a press during death
        // doesn't queue up and fire immediately on respawn) — only actually
        // sent to the server while alive (or unknown/offline, where the
        // server-side guard is the real authority anyway).
        const wantsFire = input.consumeFire();
        if (wantsFire && (!self || self.alive)) client.sendFire();
      }

      rockets.update();
      mines.update();
      dynamite.update();
      boxes.sync(client.getBoxes(), dt);
    },
  };
}
