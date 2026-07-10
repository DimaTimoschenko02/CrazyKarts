// Shared 3D-distance helpers for anything that used to be pure-XZ math and
// broke once the arena went multi-layer (bridges/decks stacked ~1.1m apart,
// see docs/plan-2026-07-09.md). The same "forgot the Y axis" bug has now
// been found and fixed FOUR times independently: weapon-box pickup
// (server/rooms/pickupRange.ts, 2026-07-09), rocket/mine/dynamite AOE
// damage + proximity-hit triggers (server/weapons/rocketSim.ts, this
// module's reason for existing), and kart-vs-kart push (src/kart/kart.ts —
// tracked separately, NOT migrated here yet to avoid stepping on concurrent
// work). Centralizing the two distance shapes that keep recurring so the
// next system reaches for these instead of re-deriving (and re-breaking)
// the same math a fifth time.
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

// Distance that treats vertical separation as "worth more" than horizontal
// separation without ever hard-gating it to zero/full — per project rule
// (.claude/rules/smooth-values.md): anything that varies continuously in
// reality (AOE falloff by distance) must stay continuous in code, no
// discrete floor/no-floor cutoff. Scaling dy by `verticalWeight` before
// folding it into hypot() means a small floor gap between decks still reads
// as a large effective distance (falloff pushes damage toward zero) while a
// same-floor blast at dy=0 is completely unaffected (verticalWeight only
// multiplies dy, never dx/dz). verticalWeight=1 recovers ordinary
// isotropic 3D distance; this is NOT that — callers pick a weight > 1 to
// make Y "count more".
export function anisotropicDist3D(dx: number, dy: number, dz: number, verticalWeight: number): number {
  return Math.hypot(dx, dz, dy * verticalWeight);
}

// True if `a` and `b` are within `radiusXZ` horizontally AND within `maxDy`
// vertically. Unlike anisotropicDist3D, this is a genuine binary gate — the
// smooth-values rule's carve-out explicitly allows hard thresholds for
// discrete trigger events (mine arming, direct-hit detection, sticking to a
// surface), which is all this is used for. `maxDy` should comfortably cover
// a kart's own body height plus whatever spawn-height offset the projectile
// launches from, so a proximity check on the SAME floor never false-negatives
// while a check across a bridge deck (~1.1m floor-to-floor) reliably gates
// out.
export function withinProximity3D(a: Point3, b: Point3, radiusXZ: number, maxDy: number): boolean {
  if (Math.abs(a.y - b.y) > maxDy) return false;
  return Math.hypot(a.x - b.x, a.z - b.z) <= radiusXZ;
}
