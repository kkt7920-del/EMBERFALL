import type { ContentDB } from "@shared/data/contentDb";
import type { BallLook } from "@shared/types/content";
import { h } from "./dom";

/** A small CSS Poké Ball icon. */
export function ballIcon(look: BallLook | undefined, size = 22): HTMLSpanElement {
  const l = look ?? { top: "#e3350d", bottom: "#f4f4f4", band: "#1e1e1e", button: "#f4f4f4" };
  const el = h("span", { class: "ball-icon", style: { width: `${size}px`, height: `${size}px` } });
  el.style.background = `linear-gradient(180deg, ${l.top} 0 46%, ${l.band} 46% 54%, ${l.bottom} 54% 100%)`;
  if (l.stripe) el.style.boxShadow = `inset 0 0 0 2px ${l.band}, inset ${size * 0.18}px ${-size * 0.18}px 0 ${-size * 0.08}px ${l.stripe}`;
  el.append(h("span", { class: "ball-icon-btn", style: { background: l.button } }));
  return el;
}

/**
 * Throwing HUD: the equipped-ball chip (bottom right, tap/click = Ball Wheel),
 * a centre reticle that turns yellow over a Pokémon in range (with its name
 * and level), a power ring while charging, and the "Gotcha!" banner.
 */
export class BallHud {
  readonly el: HTMLDivElement;
  private readonly chip: HTMLButtonElement;
  private readonly chipIcon: HTMLSpanElement;
  private readonly chipName: HTMLSpanElement;
  private readonly chipCount: HTMLSpanElement;
  private readonly strip: HTMLDivElement;
  private readonly reticle: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  onChip: () => void = () => {};
  onPick: (item: string) => void = () => {};
  private lastStrip = "";
  private lastChip = "";
  private bannerTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly db: ContentDB,
  ) {
    this.chipIcon = h("span");
    this.chipName = h("span", { class: "ball-name" });
    this.chipCount = h("span", { class: "ball-count" });
    this.chip = h("button", { class: "ball-chip", "data-testid": "ball-chip", onclick: () => this.onChip() }, this.chipIcon, h("span", { class: "ball-text" }, this.chipName, this.chipCount));
    this.strip = h("div", { class: "ball-strip" });
    this.reticle = h("div", { class: "reticle hidden", "data-testid": "reticle" }, h("i", { class: "r-top" }), h("i", { class: "r-bottom" }), h("i", { class: "r-left" }), h("i", { class: "r-right" }), h("i", { class: "r-dot" }));
    this.label = h("div", { class: "aim-label hidden", "data-testid": "aim-label" });
    this.ring = h("div", { class: "power-ring hidden", "data-testid": "power-ring" });
    this.banner = h("div", { class: "gotcha hidden", "data-testid": "gotcha" });
    this.hint = h("div", { class: "ball-hint hidden" });
    this.el = h("div", { class: "ball-hud" }, h("div", { class: "ball-dock" }, this.strip, this.chip), this.reticle, this.label, this.ring, this.banner, this.hint);
    root.appendChild(this.el);
  }

  /** Shows or hides the ball dock (the Gotcha! banner and capture hints stay visible). */
  setVisible(on: boolean): void {
    this.el.classList.toggle("dock-hidden", !on);
  }

  /** Equipped ball (or the one that would be equipped) and the owned ball list. */
  setBalls(selected: string, equipped: boolean, owned: { id: string; count: number }[], keyHints: boolean): void {
    const item = this.db.items.get(selected);
    const count = owned.find((o) => o.id === selected)?.count ?? 0;
    const key = `${selected}|${equipped}|${count}`;
    if (key !== this.lastChip) {
      this.lastChip = key;
      this.chipIcon.replaceChildren(ballIcon(item?.ball, 26));
      this.chipName.textContent = item?.name ?? selected;
      this.chipCount.textContent = `×${count}`;
      this.chip.classList.toggle("equipped", equipped);
      this.chip.classList.toggle("empty", count === 0);
    }
    const stripKey = owned.map((o) => `${o.id}:${o.count}`).join(",") + `|${selected}|${keyHints}`;
    if (stripKey !== this.lastStrip) {
      this.lastStrip = stripKey;
      this.strip.replaceChildren(
        ...owned.map((o, i) =>
          h(
            "button",
            { class: `ball-slot${o.id === selected ? " active" : ""}`, title: this.db.items.get(o.id)?.name ?? o.id, onclick: () => this.onPick(o.id) },
            ballIcon(this.db.items.get(o.id)?.ball, 18),
            keyHints ? h("kbd", null, String(i + 1)) : null,
            h("small", null, String(o.count)),
          ),
        ),
      );
    }
  }

  setAim(on: boolean, locked: boolean, text: string | null): void {
    this.reticle.classList.toggle("hidden", !on);
    this.reticle.classList.toggle("locked", locked);
    this.label.classList.toggle("hidden", !on || !text);
    if (text && this.label.textContent !== text) this.label.textContent = text;
  }

  setPower(k: number | null): void {
    this.ring.classList.toggle("hidden", k === null);
    if (k !== null) this.ring.style.setProperty("--p", `${Math.round(k * 100)}`);
  }

  setHint(text: string | null): void {
    this.hint.classList.toggle("hidden", !text);
    if (text && this.hint.textContent !== text) this.hint.textContent = text;
  }

  gotcha(title: string, sub: string): void {
    this.banner.replaceChildren(h("div", { class: "gotcha-title" }, title), h("div", { class: "gotcha-sub" }, sub));
    this.banner.classList.remove("hidden");
    this.banner.classList.remove("show");
    void this.banner.offsetWidth;
    this.banner.classList.add("show");
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.add("hidden"), 2600);
  }
}

/** Radial ball selector (mobile BALL chip, PC G key or chip click, battle "포획"). */
export class BallWheel {
  private el: HTMLDivElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly db: ContentDB,
  ) {}

  get open(): boolean {
    return this.el !== null;
  }

  show(
    balls: { id: string; count: number }[],
    selected: string,
    onPick: (id: string) => void,
    opts: { title?: string; onPutAway?: () => void; onClose?: () => void } = {},
  ): void {
    this.close();
    const n = balls.length;
    const items = balls.map((b, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const item = this.db.items.get(b.id);
      const btn = h(
        "button",
        {
          class: `wheel-slot${b.id === selected ? " active" : ""}${b.count === 0 ? " empty" : ""}`,
          "data-ball": b.id,
          disabled: b.count === 0,
          style: { left: `calc(50% + ${Math.cos(a) * 38}% )`, top: `calc(50% + ${Math.sin(a) * 38}% )` },
          onclick: (e: Event) => {
            e.stopPropagation();
            this.close();
            onPick(b.id);
          },
        },
        ballIcon(item?.ball, 34),
        h("span", { class: "wheel-name" }, item?.name ?? b.id),
        h("span", { class: "wheel-count" }, `×${b.count}`),
      );
      return btn;
    });
    const center = h(
      "button",
      {
        class: "wheel-center",
        onclick: (e: Event) => {
          e.stopPropagation();
          this.close();
          if (opts.onPutAway) opts.onPutAway();
          else opts.onClose?.();
        },
      },
      opts.onPutAway ? "볼 넣기" : "닫기",
    );
    const ring = h("div", { class: "wheel-ring" }, ...items, center);
    this.el = h(
      "div",
      {
        class: "ball-wheel",
        "data-testid": "ball-wheel",
        onclick: () => {
          this.close();
          opts.onClose?.();
        },
      },
      h("div", { class: "wheel-title" }, opts.title ?? "볼 선택"),
      ring,
    );
    this.root.appendChild(this.el);
  }

  close(): void {
    this.el?.remove();
    this.el = null;
  }
}
