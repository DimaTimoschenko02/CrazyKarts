// Browser lobby (MVP scope): nickname + room code only, no master-server
// profile/auth (that's a later P2 concern — see docs/p2-port-notes.md
// section 4 for the full Godot-era flow this intentionally simplifies).
//
// ---------------------------------------------------------------------
// HAND-OFF CONTRACT with the game client (src/main.ts, owned separately):
//   - Nickname is stored in `localStorage["sk-nick"]` (plain string, already
//     validated: 2-16 chars, [A-Za-z0-9_-]). The game reads it from there;
//     this lobby never passes it as a URL param.
//   - Room code is passed as a query param on navigation to the game:
//       `/?room=<CODE>` (6 uppercase chars from ROOM_CODE_CHARSET).
//     The game client is responsible for reading `?room=` and driving
//     Colyseus connection/room join — not implemented here.
//   - The room CREATOR also picks a map (dropdown on the "room ready"
//     screen, populated from GET /__editor-maps — a dev-only Vite plugin,
//     see vite.config.ts, that doesn't exist in a production build, hence
//     the try/catch fallback to just [ACTIVE_MAP] below). That choice rides
//     along as `&map=<name>` on both the invite link and this creator's own
//     "Go" navigation. Whoever's joinOrCreate() call actually creates the
//     Colyseus room (i.e. the first person to open a `/?room=CODE&map=...`
//     link) is the one whose map wins — see server/rooms/MatchRoom.ts
//     onCreate(). Joining by typing a bare code into "Join Room" (no link,
//     no `map` param) always gets whatever the server's default is; this
//     lobby has no way to know or influence the map in that path.
//   - Beyond the GET above, this lobby does NOT talk to the match server —
//     "Create room" only generates a client-side code for a friends-style
//     invite link; whether/how that code is registered with a real room
//     happens on the game-client side, out of scope for this page.
// ---------------------------------------------------------------------
import { generateRoomCode, isValidRoomCode, normalizeRoomCode } from "./roomCode";
import { validateNick } from "./nick";
import { ACTIVE_MAP } from "../shared/activeMap";

const NICK_STORAGE_KEY = "sk-nick";

type ScreenId = "screen-splash" | "screen-nick" | "screen-home" | "screen-room";

function showScreen(id: ScreenId): void {
  for (const el of document.querySelectorAll<HTMLElement>(".screen")) {
    el.classList.toggle("active", el.id === id);
  }
}

function getStoredNick(): string | null {
  return localStorage.getItem(NICK_STORAGE_KEY);
}

function setStoredNick(nick: string): void {
  localStorage.setItem(NICK_STORAGE_KEY, nick);
}

function clearStoredNick(): void {
  localStorage.removeItem(NICK_STORAGE_KEY);
}

function goHomeOrNick(): void {
  const nick = getStoredNick();
  if (nick) {
    renderHome(nick);
    showScreen("screen-home");
  } else {
    showScreen("screen-nick");
  }
}

// --- Splash -----------------------------------------------------------

function initSplash(): void {
  const splash = document.getElementById("screen-splash")!;
  let advanced = false;
  const advance = (): void => {
    if (advanced) return;
    advanced = true;
    goHomeOrNick();
  };
  splash.addEventListener("click", advance);
  setTimeout(advance, 1000);
}

// --- Nick entry ---------------------------------------------------------

function initNickScreen(): void {
  const input = document.getElementById("nick-input") as HTMLInputElement;
  const error = document.getElementById("nick-error")!;
  const playBtn = document.getElementById("btn-play") as HTMLButtonElement;

  const submit = (): void => {
    const result = validateNick(input.value);
    if (!result.valid) {
      error.textContent = result.error ?? "Invalid nickname";
      return;
    }
    error.textContent = "";
    setStoredNick(input.value.trim());
    renderHome(input.value.trim());
    showScreen("screen-home");
  };

  playBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// --- Home ---------------------------------------------------------------

function renderHome(nick: string): void {
  document.getElementById("home-nick")!.textContent = nick;
  // Clear any stale join-code input/error from a previous visit.
  const joinInput = document.getElementById("join-code-input") as HTMLInputElement;
  joinInput.value = "";
  document.getElementById("join-error")!.textContent = "";
}

// GET /__editor-maps is a dev-only Vite middleware (vite.config.ts
// editorMapsFilePlugin, `apply: "serve"`) that lists public/maps/*.json by
// name. It does not exist in a production build (`vite preview`/nginx), so
// this always has a working fallback: just the one map both sides already
// default to (src/shared/activeMap.ts).
async function fetchAvailableMaps(): Promise<string[]> {
  try {
    const res = await fetch("/__editor-maps");
    if (!res.ok) return [ACTIVE_MAP];
    const body = (await res.json()) as { maps?: unknown };
    const maps = Array.isArray(body.maps) ? body.maps.filter((m): m is string => typeof m === "string") : [];
    return maps.length > 0 ? maps : [ACTIVE_MAP];
  } catch {
    return [ACTIVE_MAP];
  }
}

function populateMapSelect(maps: string[]): void {
  const select = document.getElementById("map-select") as HTMLSelectElement;
  select.innerHTML = "";
  for (const name of maps) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = maps.includes(ACTIVE_MAP) ? ACTIVE_MAP : maps[0];
}

function initHomeScreen(): void {
  const changeBtn = document.getElementById("btn-change-nick")!;
  const createBtn = document.getElementById("btn-create-room")!;
  const joinBtn = document.getElementById("btn-join-room") as HTMLButtonElement;
  const joinInput = document.getElementById("join-code-input") as HTMLInputElement;
  const joinError = document.getElementById("join-error")!;

  changeBtn.addEventListener("click", () => {
    clearStoredNick();
    const nickInput = document.getElementById("nick-input") as HTMLInputElement;
    nickInput.value = "";
    document.getElementById("nick-error")!.textContent = "";
    showScreen("screen-nick");
    nickInput.focus();
  });

  createBtn.addEventListener("click", () => {
    const code = generateRoomCode();
    renderRoomScreen(code, "created");
    showScreen("screen-room");
    // Populate the map dropdown after the screen is already visible — no
    // reason to make the creator wait on this fetch before seeing their code.
    void fetchAvailableMaps().then(populateMapSelect);
  });

  const submitJoin = (): void => {
    const raw = joinInput.value;
    if (!isValidRoomCode(raw)) {
      joinError.textContent = "Enter a valid 6-character room code";
      return;
    }
    joinError.textContent = "";
    const code = normalizeRoomCode(raw);
    renderRoomScreen(code, "joined");
    showScreen("screen-room");
  };

  joinBtn.addEventListener("click", submitJoin);
  joinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitJoin();
  });
}

// --- Room hand-off --------------------------------------------------------

// `map` is only ever passed for the "created" flow (see renderRoomScreen) —
// a bare joined-by-code room has no map selection UI, so it navigates
// without the param and the game client/server both fall back to their own
// default (see src/main.ts and server/config/arena.ts loadArena()).
function buildInviteLink(code: string, map?: string): string {
  return map ? `${location.origin}/?room=${code}&map=${map}` : `${location.origin}/?room=${code}`;
}

function buildGameUrl(code: string, map?: string): string {
  return map ? `/?room=${code}&map=${map}` : `/?room=${code}`;
}

/** Copies `text` to the clipboard, falling back to a hidden-textarea trick
 * when the async Clipboard API is unavailable (e.g. LAN http:// dev server
 * is not a secure context, see .claude/skills/web-slice-workflow — LAN IP
 * testing gotcha). Returns whether the copy is believed to have worked. */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy fallback
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function renderRoomScreen(code: string, mode: "created" | "joined"): void {
  document.getElementById("room-title")!.textContent =
    mode === "created" ? "Room Created" : "Joining Room";
  document.getElementById("room-code-display")!.textContent = code;
  document.getElementById("copy-feedback")!.textContent = "";
  const goBtn = document.getElementById("btn-go") as HTMLButtonElement;
  goBtn.dataset.roomCode = code;
  // Map choice only makes sense for the room's creator — see the file-header
  // hand-off contract for why a "joined by bare code" room has no way to
  // pick one.
  const mapRow = document.getElementById("map-select-row")!;
  mapRow.style.display = mode === "created" ? "" : "none";
}

function initRoomScreen(): void {
  const copyBtn = document.getElementById("btn-copy-link") as HTMLButtonElement;
  const copyFeedback = document.getElementById("copy-feedback")!;
  const goBtn = document.getElementById("btn-go") as HTMLButtonElement;
  const backBtn = document.getElementById("btn-back-home")!;
  const mapSelect = document.getElementById("map-select") as HTMLSelectElement;

  // Reads the select fresh on each click (not captured once) so switching
  // the dropdown after the room screen renders is honored — mirrors how
  // the room code itself is already read live off the DOM below.
  function selectedMap(): string | undefined {
    const mapRow = document.getElementById("map-select-row")!;
    if (mapRow.style.display === "none") return undefined; // "joined" flow — no map choice
    return mapSelect.value || undefined;
  }

  copyBtn.addEventListener("click", () => {
    const code = document.getElementById("room-code-display")!.textContent ?? "";
    void copyToClipboard(buildInviteLink(code, selectedMap())).then((ok) => {
      copyFeedback.textContent = ok ? "Link copied!" : "Copy failed — select and copy manually";
    });
  });

  goBtn.addEventListener("click", () => {
    const code = goBtn.dataset.roomCode ?? document.getElementById("room-code-display")!.textContent ?? "";
    location.href = buildGameUrl(code, selectedMap());
  });

  backBtn.addEventListener("click", () => {
    const nick = getStoredNick();
    if (nick) renderHome(nick);
    showScreen("screen-home");
  });
}

function init(): void {
  initSplash();
  initNickScreen();
  initHomeScreen();
  initRoomScreen();
}

init();
