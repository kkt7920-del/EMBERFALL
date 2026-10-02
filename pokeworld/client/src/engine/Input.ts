export type Action = "jump" | "interact" | "attack" | "capture" | "mount" | "party" | "bag" | "map" | "menu" | "close" | "wheel" | "dex";

export interface Controls {
  /** x: strafe right, y: forward; length <= 1 */
  move: { x: number; y: number };
  run: boolean;
  jumpHeld: boolean;
  descendHeld: boolean;
  look: { dx: number; dy: number };
  zoom: number;
  pressed: Set<Action>;
  /** Poké Ball throwing: button edges (mouse left / BALL button), number-key pick, wheel cycling. */
  ball: { down: boolean; up: boolean; held: boolean; select: number | null; cycle: number };
  /** Screen point of a touch long-press (Pokémon info), if any this frame. */
  longPress: { x: number; y: number } | null;
}

const KEY_ACTIONS: Record<string, Action> = {
  Space: "jump",
  KeyE: "interact",
  Enter: "interact",
  KeyF: "attack",
  KeyR: "capture",
  KeyT: "mount",
  KeyP: "party",
  Tab: "party",
  KeyB: "bag",
  KeyI: "bag",
  KeyM: "map",
  KeyX: "dex",
  KeyG: "wheel",
  Escape: "close",
};

/**
 * Collects keyboard, mouse and touch input into one Controls snapshot per
 * frame. Touch controls write into the same state via the setters below.
 */
export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<Action>();
  private lookDx = 0;
  private lookDy = 0;
  private zoom = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  touchMove = { x: 0, y: 0 };
  touchRun = false;
  touchJumpHeld = false;
  /** When a ball is in hand the mouse wheel cycles balls and the left button throws. */
  ballMode = false;
  private ballDown = false;
  private ballUp = false;
  private ballHeld = false;
  private ballSelect: number | null = null;
  private ballCycle = 0;
  private longPressAt: { x: number; y: number } | null = null;
  /** Blocks game input (dialogs, menus, battle). UI keys still work. */
  gameplayEnabled = true;
  pointerLockAllowed = true;
  sensitivity = 1;
  invertY = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());

    // Pointer Events (not mouse events): other pointerdown handlers may call
    // preventDefault, which suppresses the legacy mouse events entirely.
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") return;
      if (e.button === 0 && this.pointerLockAllowed && this.gameplayEnabled && document.pointerLockElement !== canvas) {
        const req = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
        req?.catch?.(() => {});
      }
      if (e.button === 0 && this.ballMode && this.gameplayEnabled) this.pressBall(true);
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "mouse") return;
      this.dragging = false;
      if (e.button === 0 && this.ballHeld) this.pressBall(false);
    });
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (document.pointerLockElement === canvas) {
        // Some environments report no movementX while locked; fall back to client deltas,
        // but never to the jump between the pre-lock cursor and a locked position
        let dx = e.movementX;
        let dy = e.movementY;
        if (!dx && !dy) {
          dx = e.clientX - this.lastX;
          dy = e.clientY - this.lastY;
          if (Math.abs(dx) > 120 || Math.abs(dy) > 120) dx = dy = 0;
        }
        // Chrome occasionally reports a huge first movement after locking
        if (Math.abs(dx) < 400 && Math.abs(dy) < 400) this.addLook(dx, dy);
      } else if (this.dragging && (e.buttons & 1 || e.buttons & 2)) {
        this.addLook(e.clientX - this.lastX, e.clientY - this.lastY);
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.ballMode && !e.shiftKey) this.ballCycle += Math.sign(e.deltaY);
        else this.zoom += Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (e.code === "Tab" || e.code === "Space") e.preventDefault();
    if (!e.repeat) {
      const action = KEY_ACTIONS[e.code];
      if (action) this.press(action);
      if (e.code === "KeyQ") this.press("menu");
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.ballSelect = Number(digit[1]) - 1;
    }
    this.keys.add(e.code);
  };

  addLook(dx: number, dy: number): void {
    this.lookDx += dx * this.sensitivity;
    this.lookDy += dy * this.sensitivity * (this.invertY ? -1 : 1);
  }

  addZoom(delta: number): void {
    this.zoom += delta;
  }

  press(action: Action): void {
    this.pressed.add(action);
  }

  /** BALL button / left mouse edge. */
  pressBall(down: boolean): void {
    if (down) {
      this.ballDown = true;
      this.ballHeld = true;
    } else {
      this.ballUp = true;
      this.ballHeld = false;
    }
  }

  selectBall(index: number): void {
    this.ballSelect = index;
  }

  reportLongPress(x: number, y: number): void {
    this.longPressAt = { x, y };
  }

  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  frame(): Controls {
    const k = this.keys;
    let x = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    let y = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    if (Math.hypot(this.touchMove.x, this.touchMove.y) > Math.hypot(x, y)) {
      x = this.touchMove.x;
      y = this.touchMove.y;
    }
    const enabled = this.gameplayEnabled;
    const out: Controls = {
      move: enabled ? { x, y } : { x: 0, y: 0 },
      run: enabled && (k.has("ShiftLeft") || k.has("ShiftRight") || this.touchRun),
      jumpHeld: enabled && (k.has("Space") || this.touchJumpHeld),
      descendHeld: enabled && (k.has("ControlLeft") || k.has("KeyC")),
      look: { dx: this.lookDx, dy: this.lookDy },
      zoom: this.zoom,
      pressed: new Set(this.pressed),
      ball: { down: this.ballDown, up: this.ballUp, held: this.ballHeld, select: this.ballSelect, cycle: this.ballCycle },
      longPress: this.longPressAt,
    };
    this.pressed.clear();
    this.ballDown = false;
    this.ballUp = false;
    this.ballSelect = null;
    this.ballCycle = 0;
    this.longPressAt = null;
    this.lookDx = 0;
    this.lookDy = 0;
    this.zoom = 0;
    return out;
  }
}
