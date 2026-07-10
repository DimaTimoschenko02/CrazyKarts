// Minimal combat HUD: hp/weapon/kills-deaths text, a "RESPAWN IN N…"
// overlay while dead, a small kill-feed, and the match countdown timer.
// Plain DOM divs layered over the canvas — no framework, matches the
// existing #hud element's style in index.html (see src/debug/telemetry.ts
// updateHud for the sibling pattern).
import type { KillMsg, RemotePlayerState } from "../net/netClient";

// Mirrors server/rooms/MatchRoom.ts DEATH_RESPAWN_DELAY_MS for the countdown
// display only. Kept in sync by hand rather than imported: importing
// anything from server/ would pull in schema/MatchState.ts's decorator
// syntax, which breaks `npx tsc --noEmit` from web-slice/ (same boundary
// documented in net/netClient.ts's file header). The server's own
// clock.setTimeout is authoritative for the actual respawn timing — this
// number only drives what the countdown text shows.
const DEATH_RESPAWN_DELAY_S = 3;
const KILL_FEED_MAX_LINES = 5;
const KILL_FEED_LINE_TTL_MS = 6000;

// Weapon codes -> HUD label (src/net/netClient.ts RemotePlayerState.weapon:
// "" | "rocket" | "mines" | "dynamite").
function weaponLabel(weapon: string): string {
  switch (weapon) {
    case "rocket":
      return "ROCKET";
    case "mines":
      return "MINES";
    case "dynamite":
      return "DYNAMITE";
    default:
      return "--";
  }
}

export class CombatHud {
  private wasAlive = true;
  private deathAt = 0;

  private constructor(
    private readonly statsEl: HTMLElement,
    private readonly respawnEl: HTMLElement,
    private readonly killFeedEl: HTMLElement,
    private readonly timerEl: HTMLElement,
    private readonly chargeBarEl: HTMLElement,
    private readonly chargeFillEl: HTMLElement
  ) {}

  // Creates and appends its own DOM elements — no index.html changes needed
  // (keeps this module self-contained and avoids touching markup shared with
  // the lobby entry point).
  static mount(): CombatHud {
    const statsEl = document.createElement("div");
    statsEl.id = "combat-hud";
    Object.assign(statsEl.style, {
      position: "fixed", top: "10px", right: "10px", zIndex: "10",
      font: "14px/1.5 monospace", color: "#fff", background: "rgba(20,0,0,.55)",
      padding: "8px 12px", border: "1px solid #f664", borderRadius: "6px",
      whiteSpace: "pre",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(statsEl);

    const respawnEl = document.createElement("div");
    respawnEl.id = "respawn-overlay";
    Object.assign(respawnEl.style, {
      position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
      zIndex: "20", font: "bold 28px/1.4 monospace", color: "#ff5050",
      textShadow: "0 0 8px #000", display: "none", pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(respawnEl);

    const killFeedEl = document.createElement("div");
    killFeedEl.id = "kill-feed";
    Object.assign(killFeedEl.style, {
      position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
      zIndex: "10", font: "13px/1.4 monospace", color: "#fff",
      textAlign: "center", pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(killFeedEl);

    // Neon Stadium palette (docs/p2-port-notes.md ACCENT_GOLD #FFD633) — the
    // one HUD element every player glances at repeatedly, so it gets the
    // "important" accent color instead of plain white.
    const timerEl = document.createElement("div");
    timerEl.id = "match-timer";
    Object.assign(timerEl.style, {
      position: "fixed", top: "10px", left: "10px", zIndex: "10",
      font: "bold 18px/1.4 monospace", color: "#FFD633",
      textShadow: "0 0 6px #000", pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(timerEl);

    // Dynamite charge bar — only shown while charge-and-throw is actually
    // charging (updateCharge(null) hides it), positioned just below the
    // stats box in the same top-right corner so the eye doesn't have to
    // travel to check throw strength.
    const chargeBarEl = document.createElement("div");
    chargeBarEl.id = "charge-bar";
    Object.assign(chargeBarEl.style, {
      position: "fixed", top: "78px", right: "10px", zIndex: "10",
      width: "140px", height: "10px", background: "rgba(0,0,0,.5)",
      border: "1px solid #f664", borderRadius: "4px", overflow: "hidden",
      display: "none", pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    const chargeFillEl = document.createElement("div");
    Object.assign(chargeFillEl.style, {
      height: "100%", width: "0%", background: "#FFD633",
    } satisfies Partial<CSSStyleDeclaration>);
    chargeBarEl.appendChild(chargeFillEl);
    document.body.appendChild(chargeBarEl);

    return new CombatHud(statsEl, respawnEl, killFeedEl, timerEl, chargeBarEl, chargeFillEl);
  }

  // Call once per rendered frame with the local player's own schema state
  // (NetClient.getSelf()) — null while offline or before the join handshake
  // completes.
  updateStats(self: RemotePlayerState | null): void {
    if (!self) {
      this.statsEl.textContent = "offline";
      this.respawnEl.style.display = "none";
      this.wasAlive = true;
      return;
    }
    this.statsEl.textContent =
      `HP    ${Math.max(0, Math.round(self.hp))}\n` +
      `WPN   ${weaponLabel(self.weapon)}\n` +
      `K/D   ${self.kills} / ${self.deaths}`;

    if (self.alive) {
      this.wasAlive = true;
      this.respawnEl.style.display = "none";
      return;
    }
    if (this.wasAlive) this.deathAt = performance.now();
    this.wasAlive = false;

    const remaining = Math.max(0, DEATH_RESPAWN_DELAY_S - (performance.now() - this.deathAt) / 1000);
    this.respawnEl.style.display = "block";
    this.respawnEl.textContent = `RESPAWN IN ${remaining.toFixed(1)}…`;
  }

  // matchEndsAt is a unix ms timestamp from the SERVER's clock
  // (server/schema/MatchState.ts) compared against Date.now() on the CLIENT.
  // No clock-sync handshake exists for this MVP — a few hundred ms of client/
  // server clock skew just shows up as the countdown being briefly a beat
  // off, which is an acceptable tradeoff for not building NTP-style sync for
  // a single cosmetic timer. Hidden entirely offline (matchEndsAt === 0,
  // NetClient.getMatchEndsAt()'s default when there's no room).
  updateTimer(matchEndsAt: number): void {
    if (matchEndsAt <= 0) {
      this.timerEl.style.display = "none";
      return;
    }
    this.timerEl.style.display = "block";
    const remainingS = Math.max(0, Math.round((matchEndsAt - Date.now()) / 1000));
    const mm = Math.floor(remainingS / 60);
    const ss = remainingS % 60;
    this.timerEl.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
  }

  // Call once per rendered frame while holding the dynamite charge (combat/
  // index.ts). `fraction` is 0..1 (heldMs/maxChargeMs); pass null to hide the
  // bar entirely (not charging / not holding dynamite / offline).
  updateCharge(fraction: number | null): void {
    if (fraction === null) {
      this.chargeBarEl.style.display = "none";
      return;
    }
    this.chargeBarEl.style.display = "block";
    this.chargeFillEl.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  pushKillFeed(msg: KillMsg): void {
    // sessionIds are opaque (not nicks) — the "kill" broadcast doesn't carry
    // nicknames (see MatchRoom.killPlayer). Good enough for an MVP feed;
    // thread nicks through later if this needs to read nicely.
    const line = document.createElement("div");
    line.textContent = msg.killerId === msg.victimId
      ? `${short(msg.victimId)} self-destructed`
      : `${short(msg.killerId)} ✕ ${short(msg.victimId)}`;
    this.killFeedEl.prepend(line);
    while (this.killFeedEl.childElementCount > KILL_FEED_MAX_LINES) {
      this.killFeedEl.lastChild?.remove();
    }
    setTimeout(() => line.remove(), KILL_FEED_LINE_TTL_MS);
  }
}

function short(sessionId: string): string {
  return sessionId.slice(0, 6);
}
