import type { Action, Input } from "../engine/Input";

interface ButtonDef {
  action: Action | "jumpHold" | "ballHold";
  label: string;
  cls: string;
}

const BUTTONS: ButtonDef[] = [
  { action: "interact", label: "A", cls: "btn-a" },
  { action: "attack", label: "배틀", cls: "btn-attack" },
  { action: "jumpHold", label: "점프", cls: "btn-jump" },
  { action: "ballHold", label: "BALL", cls: "btn-ball" },
  { action: "mount", label: "탑승", cls: "btn-mount" },
];

const LONG_PRESS_MS = 450;

/**
 * On-screen controls for phones and tablets.
 *  - left half: floating virtual joystick (appears under the thumb)
 *  - right half: drag to turn the camera, pinch to zoom
 *  - action buttons, usable while both thumbs are busy (multi-touch)
 * Uses Pointer Events (one id per finger); falls back to Touch Events where
 * Pointer Events are missing.
 */
export class TouchControls {
  readonly el: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private readonly lookers = new Map<number, { x: number; y: number; sx: number; sy: number; at: number; moved: boolean; timer: number }>();
  private pinchDist = 0;
  /** Whether a ball is in hand (tap on BALL then throws instead of equipping). */
  ballEquipped = () => false;
  /** Equip request from a BALL tap while not holding a ball. */
  onEquip: () => void = () => {};

  constructor(
    root: HTMLElement,
    private readonly input: Input,
  ) {
    this.el = document.createElement("div");
    this.el.className = "touch-layer";
    this.el.innerHTML = `
      <div class="joystick" aria-hidden="true"><div class="joystick-knob"></div></div>
      <div class="touch-buttons">${BUTTONS.map((b) => `<button class="tbtn ${b.cls}" data-action="${b.action}">${b.label}</button>`).join("")}</div>`;
    root.appendChild(this.el);
    this.stick = this.el.querySelector(".joystick")!;
    this.knob = this.el.querySelector(".joystick-knob")!;

    for (const btn of this.el.querySelectorAll<HTMLButtonElement>(".tbtn")) this.bindButton(btn);

    if ("PointerEvent" in window) {
      this.el.addEventListener("pointerdown", this.onDown);
      this.el.addEventListener("pointermove", this.onMove);
      this.el.addEventListener("pointerup", this.onUp);
      this.el.addEventListener("pointercancel", this.onUp);
    } else {
      this.bindTouchFallback();
    }
  }

  setVisible(on: boolean): void {
    this.el.style.display = on ? "" : "none";
    if (!on) this.resetStick();
  }

  /** Hides gameplay buttons during battles/dialogs but keeps layer for camera. */
  setGameplay(on: boolean): void {
    this.el.classList.toggle("touch-disabled", !on);
    if (!on) this.resetStick();
  }

  /** Battle capture aim: only the BALL button and camera drag. */
  setAimOnly(on: boolean): void {
    this.el.classList.toggle("touch-aim-only", on);
  }

  private bindButton(btn: HTMLButtonElement): void {
    const action = btn.dataset.action as Action | "jumpHold" | "ballHold";
    let ballPress = false;
    const down = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add("pressed");
      if (action === "jumpHold") {
        this.input.touchJumpHeld = true;
        this.input.press("jump");
      } else if (action === "ballHold") {
        // Tap = take a ball in hand; with a ball in hand, hold = aim/charge, release = throw
        if (this.ballEquipped()) {
          ballPress = true;
          this.input.pressBall(true);
        } else this.onEquip();
      } else this.input.press(action);
    };
    const up = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove("pressed");
      if (action === "jumpHold") this.input.touchJumpHeld = false;
      if (action === "ballHold" && ballPress) {
        ballPress = false;
        this.input.pressBall(false);
      }
    };
    if ("PointerEvent" in window) {
      btn.addEventListener("pointerdown", down);
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointercancel", up);
      // The BALL button keeps its finger even if it slides off (aiming with the same thumb)
      if (action !== "ballHold") btn.addEventListener("pointerleave", up);
      else btn.addEventListener("pointerdown", (e) => btn.setPointerCapture?.((e as PointerEvent).pointerId));
    } else {
      btn.addEventListener("touchstart", down, { passive: false });
      btn.addEventListener("touchend", up, { passive: false });
      btn.addEventListener("touchcancel", up, { passive: false });
    }
  }

  private isJoystickSide(x: number, y: number): boolean {
    return x < window.innerWidth * 0.42 && y > window.innerHeight * 0.3;
  }

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".tbtn")) return;
    e.preventDefault();
    this.el.setPointerCapture?.(e.pointerId);
    this.start(e.pointerId, e.clientX, e.clientY);
  };

  private onMove = (e: PointerEvent) => {
    e.preventDefault();
    this.move(e.pointerId, e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent) => {
    this.end(e.pointerId);
  };

  private start(id: number, x: number, y: number): void {
    if (this.joyId === null && this.isJoystickSide(x, y) && !this.el.classList.contains("touch-disabled")) {
      this.joyId = id;
      this.joyOrigin = { x, y };
      this.stick.style.left = `${x}px`;
      this.stick.style.top = `${y}px`;
      this.stick.classList.add("active");
      this.knob.style.transform = "translate(-50%, -50%)";
      return;
    }
    const timer = window.setTimeout(() => {
      const l = this.lookers.get(id);
      if (l && !l.moved) this.input.reportLongPress(l.x, l.y);
    }, LONG_PRESS_MS);
    this.lookers.set(id, { x, y, sx: x, sy: y, at: performance.now(), moved: false, timer });
    if (this.lookers.size === 2) this.pinchDist = this.lookerDistance();
  }

  private move(id: number, x: number, y: number): void {
    if (id === this.joyId) {
      const radius = Math.min(70, window.innerHeight * 0.13);
      let dx = x - this.joyOrigin.x;
      let dy = y - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx = (dx / len) * radius;
        dy = (dy / len) * radius;
      }
      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const nx = dx / radius;
      const ny = -dy / radius;
      const mag = Math.hypot(nx, ny);
      const dead = 0.12;
      const scale = mag < dead ? 0 : (mag - dead) / (1 - dead) / mag;
      this.input.touchMove = { x: nx * scale, y: ny * scale };
      this.input.touchRun = mag > 0.92;
      return;
    }
    const prev = this.lookers.get(id);
    if (!prev) return;
    if (Math.hypot(x - prev.sx, y - prev.sy) > 12) prev.moved = true;
    if (this.lookers.size >= 2) {
      prev.x = x;
      prev.y = y;
      const d = this.lookerDistance();
      this.input.addZoom((this.pinchDist - d) * 0.03);
      this.pinchDist = d;
      return;
    }
    this.input.addLook((x - prev.x) * 1.4, (y - prev.y) * 1.4);
    prev.x = x;
    prev.y = y;
  }

  private end(id: number): void {
    if (id === this.joyId) this.resetStick();
    const l = this.lookers.get(id);
    if (l) clearTimeout(l.timer);
    this.lookers.delete(id);
  }

  private lookerDistance(): number {
    const pts = [...this.lookers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private resetStick(): void {
    this.joyId = null;
    this.stick.classList.remove("active");
    this.input.touchMove = { x: 0, y: 0 };
    this.input.touchRun = false;
  }

  private bindTouchFallback(): void {
    const each = (e: TouchEvent, fn: (id: number, x: number, y: number) => void) => {
      for (const t of Array.from(e.changedTouches)) fn(t.identifier, t.clientX, t.clientY);
    };
    this.el.addEventListener("touchstart", (e) => {
      if ((e.target as HTMLElement).closest(".tbtn")) return;
      e.preventDefault();
      each(e, (id, x, y) => this.start(id, x, y));
    }, { passive: false });
    this.el.addEventListener("touchmove", (e) => {
      e.preventDefault();
      each(e, (id, x, y) => this.move(id, x, y));
    }, { passive: false });
    const end = (e: TouchEvent) => each(e, (id) => this.end(id));
    this.el.addEventListener("touchend", end, { passive: false });
    this.el.addEventListener("touchcancel", end, { passive: false });
  }
}
