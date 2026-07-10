// Real keyboard input + scripted override for deterministic agent-driven
// runs. window.__runScript([{throttle, steer, ms}, ...]) — steps run
// sequentially in SIMULATED time, so runs are deterministic at any render
// fps (wiring lives in debug/telemetry.ts, which owns the window.* surface).
// Steer convention matches Godot input axis: +1 = LEFT, -1 = RIGHT.
export interface RawInput {
  throttle: number;
  steer: number;
}

export interface ScriptStep extends RawInput {
  ms: number;
}

interface ScriptCursor {
  steps: ScriptStep[];
  i: number;
  remainingMs: number;
}

export class InputController {
  private readonly keys: Record<string, boolean> = {};
  private script: ScriptCursor | null = null;
  private _scriptDone = true;

  // Fire input needs BOTH edge-triggered semantics (instant weapons —
  // rocket, mines: one press = one shot, holding down doesn't spam) AND
  // hold-duration semantics (charge weapon — dynamite: combat/index.ts
  // reads isFireHeld() every frame while charging, then consumeFireRelease()
  // on release to get the actual throw strength). Two physical sources
  // (Space + left click) are OR'd into one logical "fire" button, held true
  // as long as EITHER is down.
  private spaceDown = false;
  private mouseDown = false;
  private fireHeld = false;
  private firePressed = false; // edge: went from up to down since last consume
  private fireReleased = false; // edge: went from down to up since last consume

  constructor() {
    addEventListener("keydown", e => {
      this.keys[e.code] = true;
      if (e.code === "Space") {
        this.spaceDown = true;
        this.refreshFireHeld();
      }
    });
    addEventListener("keyup", e => {
      this.keys[e.code] = false;
      if (e.code === "Space") {
        this.spaceDown = false;
        this.refreshFireHeld();
      }
    });
    addEventListener("mousedown", e => {
      if (e.button === 0) {
        this.mouseDown = true;
        this.refreshFireHeld();
      }
    });
    addEventListener("mouseup", e => {
      if (e.button === 0) {
        this.mouseDown = false;
        this.refreshFireHeld();
      }
    });
  }

  private refreshFireHeld(): void {
    const held = this.spaceDown || this.mouseDown;
    if (held && !this.fireHeld) this.firePressed = true;
    if (!held && this.fireHeld) this.fireReleased = true;
    this.fireHeld = held;
  }

  // True at most once per press (Space or left-click), however long the
  // button is held. Call once per rendered frame. Used by instant-fire
  // weapons (rocket, mines).
  consumeFire(): boolean {
    if (!this.firePressed) return false;
    this.firePressed = false;
    return true;
  }

  // True exactly once, the frame the fire button goes back up — used by the
  // charge-and-throw weapon (dynamite) to know when to send the actual
  // throw. Call once per rendered frame.
  consumeFireRelease(): boolean {
    if (!this.fireReleased) return false;
    this.fireReleased = false;
    return true;
  }

  // Current physical state (not edge-triggered) — polled every frame while
  // charging a throw to compute how long the button has been held.
  isFireHeld(): boolean {
    return this.fireHeld;
  }

  get scriptDone(): boolean {
    return this._scriptDone;
  }

  get isScripted(): boolean {
    return this.script !== null;
  }

  runScript(steps: ScriptStep[]): string {
    this.script = { steps, i: 0, remainingMs: steps[0].ms };
    this._scriptDone = false;
    return "started " + steps.length + " steps";
  }

  // Advances the script clock by one substep and returns the raw input for
  // it; falls back to live keyboard state once the script finishes (or if
  // none is running).
  next(stepMs: number): RawInput {
    if (this.script) {
      const s = this.script.steps[this.script.i];
      this.script.remainingMs -= stepMs;
      if (this.script.remainingMs <= 0) {
        this.script.i++;
        if (this.script.i >= this.script.steps.length) {
          this.script = null;
          this._scriptDone = true;
        } else {
          this.script.remainingMs = this.script.steps[this.script.i].ms;
        }
      }
      return { throttle: s.throttle, steer: s.steer };
    }
    const throttle = (this.keys.KeyW ? 1 : 0) - (this.keys.KeyS ? 1 : 0);
    const steer = (this.keys.KeyA ? 1 : 0) - (this.keys.KeyD ? 1 : 0); // A = left = +1
    return { throttle, steer };
  }
}
