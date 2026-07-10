// Renders dynamite from server broadcast messages (server/rooms/MatchRoom.ts
// "dynamite:spawn"/"dynamite:stick"/"dynamite:update"/"dynamite:explode").
// Flight is a deterministic gravity parabola, so — same convention as
// combat/rockets.ts uses for straight-line rockets — the client extrapolates
// it analytically from ONE spawn message instead of needing a per-tick
// position broadcast. Once stuck, position is driven by explicit messages
// instead (a fixed point, or one "dynamite:update" per tick while riding
// along on whichever kart it stuck to).
import * as THREE from "three";
import type {
  DynamiteExplodeMsg,
  DynamiteSpawnMsg,
  DynamiteStickMsg,
  DynamiteUpdateMsg,
} from "../net/netClient";

const DYNAMITE_COLOR = 0xcc2222;
const EXPLOSION_COLOR = 0xff8822;
const EXPLOSION_DURATION_MS = 380;
// Bigger than a rocket/mine's blast — matches WEAPON_TYPES.dynamite's larger
// aoeRadius (src/weapons/stats.ts), purely cosmetic scaling here (same
// hand-tuned-per-weapon convention as rockets.ts/mines.ts's own
// EXPLOSION_MAX_SCALE, not a formula derived from aoeRadius). Bumped 11->16.5
// in step with the 2026-07-10 aoeRadius buff (4.5m -> 6.75m, x1.5) to keep
// the blast looking proportionally as big as it now hits.
const EXPLOSION_MAX_SCALE = 16.5;

interface LiveDynamite {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  vel0: THREE.Vector3;
  gravity: number;
  spawnAt: number; // performance.now() ms
  stuck: boolean;
}

interface LiveExplosion {
  mesh: THREE.Mesh;
  bornAt: number;
}

export class DynamiteManager {
  private readonly live = new Map<string, LiveDynamite>();
  private readonly explosions: LiveExplosion[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  spawn(msg: DynamiteSpawnMsg): void {
    const geo = new THREE.SphereGeometry(0.22, 10, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: DYNAMITE_COLOR,
      emissive: DYNAMITE_COLOR,
      emissiveIntensity: 0.35,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(msg.origin.x, msg.origin.y, msg.origin.z);
    this.scene.add(mesh);

    this.live.set(msg.id, {
      mesh,
      origin: new THREE.Vector3(msg.origin.x, msg.origin.y, msg.origin.z),
      vel0: new THREE.Vector3(msg.dir3d.x, msg.dir3d.y, msg.dir3d.z).multiplyScalar(msg.speed),
      gravity: msg.gravity,
      spawnAt: performance.now(),
      stuck: false,
    });
  }

  stick(msg: DynamiteStickMsg): void {
    const d = this.live.get(msg.id);
    if (!d) return;
    d.stuck = true;
    d.mesh.position.set(msg.x, msg.y, msg.z);
  }

  // Only arrives for dynamite stuck to a MOVING kart — rebases the mesh onto
  // the victim's latest position each tick so the thrower (and everyone
  // else) can watch it ride along instead of floating at the original stick
  // point.
  followUpdate(msg: DynamiteUpdateMsg): void {
    const d = this.live.get(msg.id);
    if (!d) return;
    d.mesh.position.set(msg.x, msg.y, msg.z);
  }

  explode(msg: DynamiteExplodeMsg): void {
    const d = this.live.get(msg.id);
    if (d) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      (d.mesh.material as THREE.Material).dispose();
      this.live.delete(msg.id);
    }
    this.spawnExplosionVfx(new THREE.Vector3(msg.x, msg.y, msg.z));
  }

  private spawnExplosionVfx(pos: THREE.Vector3): void {
    const geo = new THREE.SphereGeometry(0.32, 14, 10);
    const mat = new THREE.MeshBasicMaterial({ color: EXPLOSION_COLOR, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.explosions.push({ mesh, bornAt: performance.now() });
  }

  // Call once per rendered frame. In-flight (unstuck) position follows the
  // SAME closed-form parabola the server computes each tick
  // (server/weapons/dynamiteSim.ts dynamitePositionAtT: pos = origin +
  // vel0*t + 0.5*(0,-g,0)*t^2) — duplicated here rather than imported, same
  // "client re-derives the trivial analytic motion locally" convention
  // combat/rockets.ts already uses for rockets, so this module has zero
  // dependency on server/.
  update(): void {
    const now = performance.now();

    for (const d of this.live.values()) {
      if (d.stuck) continue; // position driven by stick()/followUpdate() messages instead
      const t = (now - d.spawnAt) / 1000;
      d.mesh.position.set(
        d.origin.x + d.vel0.x * t,
        d.origin.y + d.vel0.y * t - 0.5 * d.gravity * t * t,
        d.origin.z + d.vel0.z * t
      );
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      const age = now - e.bornAt;
      if (age > EXPLOSION_DURATION_MS) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
        this.explosions.splice(i, 1);
        continue;
      }
      const t = age / EXPLOSION_DURATION_MS;
      e.mesh.scale.setScalar(1 + t * EXPLOSION_MAX_SCALE);
      (e.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
    }
  }
}
