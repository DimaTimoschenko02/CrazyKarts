// Renders mines from server broadcast messages (server/rooms/MatchRoom.ts
// "mine:spawn"/"mine:explode"/"mine:despawn") — mines don't move once
// dropped, so unlike rockets/dynamite there's no motion to extrapolate, just
// three static VFX states: sitting-unarmed, blinking-armed (cosmetic only —
// the server decides arming/triggering, this is purely "does it look like a
// live mine yet"), and gone (explode w/ VFX, or silent despawn on expiry).
import * as THREE from "three";
import type { MineDespawnMsg, MineExplodeMsg, MineSpawnMsg } from "../net/netClient";

const MINE_BODY_COLOR = 0x1a1a1a;
const MINE_ARMED_EMISSIVE = 0xff2222;
// Purely cosmetic — mirrors WEAPON_TYPES.mines.armDelayS (src/weapons/
// stats.ts) but kept as a local literal rather than imported: the SERVER is
// authoritative for when a mine can actually trigger, this only decides
// when the little light starts blinking, so a mismatch here is a visual
// nit, never a gameplay bug.
const ARM_DELAY_S = 0.8;
const BLINK_HZ = 3.3; // ~300ms blink period once armed — fast enough to read as "live"

const EXPLOSION_COLOR = 0xffaa33;
const EXPLOSION_DURATION_MS = 280;
const EXPLOSION_MAX_SCALE = 7;

interface LiveMine {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  spawnAt: number; // performance.now() ms
  armed: boolean;
}

interface LiveExplosion {
  mesh: THREE.Mesh;
  bornAt: number;
}

export class MineManager {
  private readonly live = new Map<string, LiveMine>();
  private readonly explosions: LiveExplosion[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  spawn(msg: MineSpawnMsg): void {
    const geo = new THREE.CylinderGeometry(0.22, 0.24, 0.12, 12);
    const mat = new THREE.MeshStandardMaterial({ color: MINE_BODY_COLOR, emissive: 0x000000 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(msg.x, msg.y + 0.06, msg.z);
    this.scene.add(mesh);
    this.live.set(msg.id, { mesh, mat, spawnAt: performance.now(), armed: false });
  }

  explode(msg: MineExplodeMsg): void {
    this.removeLive(msg.id);
    this.spawnExplosionVfx(new THREE.Vector3(msg.x, msg.y, msg.z));
  }

  // Lifetime expiry — no AOE, no explosion VFX (task spec: "тихий деспавн").
  despawn(msg: MineDespawnMsg): void {
    this.removeLive(msg.id);
  }

  private removeLive(id: string): void {
    const m = this.live.get(id);
    if (!m) return;
    this.scene.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mat.dispose();
    this.live.delete(id);
  }

  private spawnExplosionVfx(pos: THREE.Vector3): void {
    const geo = new THREE.SphereGeometry(0.25, 12, 8);
    const mat = new THREE.MeshBasicMaterial({ color: EXPLOSION_COLOR, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.explosions.push({ mesh, bornAt: performance.now() });
  }

  // Call once per rendered frame.
  update(): void {
    const now = performance.now();

    for (const m of this.live.values()) {
      const ageS = (now - m.spawnAt) / 1000;
      const armed = ageS >= ARM_DELAY_S;
      if (armed !== m.armed) m.armed = armed;
      if (armed) {
        // Gentle on/off blink once armed — purely cosmetic readout, no
        // gameplay meaning (the server's own arm delay is authoritative).
        const phase = Math.sin(ageS * BLINK_HZ * Math.PI * 2);
        m.mat.emissive.setHex(MINE_ARMED_EMISSIVE);
        m.mat.emissiveIntensity = 0.3 + 0.7 * Math.max(0, phase);
      }
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
