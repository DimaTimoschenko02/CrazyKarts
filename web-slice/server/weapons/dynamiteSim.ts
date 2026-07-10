// Pure dynamite simulation math — no Colyseus/schema deps, unit-testable in
// isolation. Same style as rocketSim.ts/mineSim.ts. New gameplay-programmer
// work (2026-07-10 task brief), no reference implementation to port.
//
// Swept terrain/deck/prop collision for a flying dynamite used to live here
// (sweepDynamiteSegment) — moved to server/weapons/projectileSweep.ts
// (sweepProjectileSegment) once rocketSim needed the exact same primitive
// (2026-07-10 follow-up, "НИКАКОЕ оружие не пролетает сквозь объекты"); see
// server/rooms/MatchRoom.ts tickDynamite for the current caller.
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// The server never trusts a client-reported hold duration (a modified client
// could hold Space "forever" and claim any holdMs) — every fire message's
// holdMs gets run through this before it touches gameplay.
export function clampHoldMs(holdMs: number, maxChargeMs: number): number {
  if (!Number.isFinite(holdMs)) return 0;
  return Math.max(0, Math.min(maxChargeMs, holdMs));
}

// 0 (tap) .. 1 (held to maxChargeMs or beyond, clamped).
export function chargeFraction(holdMs: number, maxChargeMs: number): number {
  if (maxChargeMs <= 0) return 1;
  return clampHoldMs(holdMs, maxChargeMs) / maxChargeMs;
}

// Linear interpolation between the min/max launch speed by charge fraction.
export function computeLaunchSpeed(charge: number, speedMin: number, speedMax: number): number {
  const t = Math.max(0, Math.min(1, charge));
  return speedMin + (speedMax - speedMin) * t;
}

// Unit launch direction: `angleDeg` above horizontal, in the kart's forward
// direction (forwardOf(yaw) convention: (-sin(yaw), 0, -cos(yaw)), matches
// rocketSim.ts's directionAt/tiltDirection3D). Horizontal components shrink
// by cos(angle) and the vertical component is sin(angle), so the result
// stays unit length regardless of angleDeg.
export function computeLaunchDir3D(yaw: number, angleDeg: number): Vec3 {
  const angleRad = (angleDeg * Math.PI) / 180;
  const horiz = Math.cos(angleRad);
  const vertical = Math.sin(angleRad);
  return { x: -Math.sin(yaw) * horiz, y: vertical, z: -Math.cos(yaw) * horiz };
}

// Closed-form ballistic position at time t since launch: pos = origin +
// vel0*t + 0.5*(0,-gravity,0)*t^2. Used by the server every tick (instead of
// incremental Euler integration) so there's zero compounding numerical
// error over a long flight, AND so it's the exact same formula the client
// re-derives locally to extrapolate the same parabola from one
// "dynamite:spawn" message (see combat/dynamite.ts — deliberately duplicated
// there rather than imported, same "client re-derives trivial analytic
// motion" convention combat/rockets.ts already uses for straight-line
// rockets).
export function dynamitePositionAtT(origin: Vec3, vel0: Vec3, gravity: number, t: number): Vec3 {
  return {
    x: origin.x + vel0.x * t,
    y: origin.y + vel0.y * t - 0.5 * gravity * t * t,
    z: origin.z + vel0.z * t,
  };
}
