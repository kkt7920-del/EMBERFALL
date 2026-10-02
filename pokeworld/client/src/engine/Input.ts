export type Action = "jump" | "interact" | "attack" | "capture" | "mount" | "party" | "bag" | "map" | "menu" | "close";

export interface Controls {
  /** x: strafe right, y: forward; length <= 1 */
  move: { x: number; y: number };
  run: boolean;
  jumpHeld: boolean;
  descendHeld: boolean;
  look: { dx: number; dy: number };
  zoom: number;
  pressed: Set<Action>;
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
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") this.dragging = false;
    });
    window.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (document.pointerLockElement === canvas) {
        // Some environments report no movementX while locked; fall back to client deltas
        const dx = e.movementX || e.clientX - this.lastX;
        const dy = e.movementY || e.clientY - this.lastY;
        this.addLook(dx, dy);
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
        this.zoom += Math.sign(e.deltaY);
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
    };
    this.pressed.clear();
    this.lookDx = 0;
    this.lookDy = 0;
    this.zoom = 0;
    return out;
  }
}
