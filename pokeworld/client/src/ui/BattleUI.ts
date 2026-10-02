import type { ContentDB } from "@shared/data/contentDb";
import type { BattleCreatureView } from "@shared/types/battle";
import type { MoveSlot } from "@shared/types/game";
import { h, hpColor } from "./dom";

export interface BattleMenuHandlers {
  fight: (index: number) => void;
  bag: () => void;
  capture: () => void;
  party: () => void;
  run: () => void;
}

export const STATUS_LABEL: Record<string, string> = { sleep: "잠듦", freeze: "얼음", paralysis: "마비", poison: "독", burn: "화상" };

/** Battle HUD: HP plates, message box and a large, thumb-friendly command menu. */
export class BattleUI {
  readonly el: HTMLDivElement;
  private readonly foe: HTMLDivElement;
  private readonly mine: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly menu: HTMLDivElement;
  private tapResolve: (() => void) | null = null;

  constructor(root: HTMLElement, private readonly db: ContentDB) {
    this.foe = h("div", { class: "bstatus foe" });
    this.mine = h("div", { class: "bstatus mine" });
    this.message = h("div", { class: "bmessage", onclick: () => this.tapResolve?.() });
    this.menu = h("div", { class: "bmenu" });
    this.el = h("div", { class: "battle-ui hidden" }, this.foe, this.mine, this.message, this.menu);
    root.appendChild(this.el);
  }

  show(on: boolean): void {
    this.el.classList.toggle("hidden", !on);
  }

  private plate(el: HTMLElement, c: BattleCreatureView, label: string, exp?: number): void {
    const ratio = c.hp / c.maxHp;
    const gender = c.gender === "male" ? "♂" : c.gender === "female" ? "♀" : "";
    el.replaceChildren(
      h(
        "div",
        { class: "name" },
        h("span", null, `${label}${c.name}`, gender ? h("b", { class: `gender ${c.gender}` }, gender) : null, c.alpha ? h("b", { class: "alpha-badge" }, "ALPHA") : null),
        h("span", null, h("i", { class: `status-chip${c.status ? ` s-${c.status}` : " hidden"}` }, c.status ? STATUS_LABEL[c.status] : ""), ` Lv.${c.level}`),
      ),
      h("div", { class: "bar" }, h("div", { class: "hpfill", style: { width: `${ratio * 100}%`, background: hpColor(ratio) } })),
      h("div", { class: "hpnum" }, `${Math.max(0, c.hp)} / ${c.maxHp}`),
      ...(exp !== undefined ? [h("div", { class: "bar exp" }, h("div", { style: { width: `${exp * 100}%` } }))] : []),
    );
  }

  setFoe(c: BattleCreatureView, wild: boolean): void {
    this.plate(this.foe, c, wild ? "야생 " : "");
  }

  setMine(c: BattleCreatureView, exp: number): void {
    this.plate(this.mine, c, "", exp);
  }

  setHp(side: "player" | "foe", hp: number, max: number): void {
    const el = side === "player" ? this.mine : this.foe;
    const fill = el.querySelector<HTMLDivElement>(".hpfill");
    const num = el.querySelector<HTMLDivElement>(".hpnum");
    const ratio = Math.max(0, hp) / max;
    if (fill) {
      fill.style.width = `${ratio * 100}%`;
      fill.style.background = hpColor(ratio);
    }
    if (num) num.textContent = `${Math.max(0, hp)} / ${max}`;
  }

  setStatus(side: "player" | "foe", status: string | null): void {
    const el = side === "player" ? this.mine : this.foe;
    const chip = el.querySelector<HTMLElement>(".status-chip");
    if (!chip) return;
    chip.className = `status-chip${status ? ` s-${status}` : " hidden"}`;
    chip.textContent = status ? STATUS_LABEL[status] ?? status : "";
  }

  /** Aiming a ball during battle: the menu and message box step aside. */
  setAiming(on: boolean): void {
    this.el.classList.toggle("aiming", on);
  }

  say(text: string): void {
    this.message.textContent = text;
  }

  /** Resolves on tap or after `ms`. */
  waitTap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        window.removeEventListener("keydown", onKey, true);
        this.tapResolve = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      const onKey = (e: KeyboardEvent) => {
        if (e.code === "Space" || e.code === "Enter" || e.code === "KeyE") {
          e.preventDefault();
          done();
        }
      };
      window.addEventListener("keydown", onKey, true);
      this.tapResolve = done;
    });
  }

  hideMenu(): void {
    this.menu.replaceChildren();
  }

  rootMenu(handlers: BattleMenuHandlers, opts: { canCapture: boolean; canRun: boolean; moves: MoveSlot[]; orbs: number }): void {
    const btn = (label: string, sub: string, cls: string, fn: () => void, disabled = false) =>
      h("button", { class: cls, disabled, onclick: fn }, label, sub ? h("small", null, sub) : null);
    this.menu.replaceChildren(
      btn("싸운다", "기술 선택", "fight", () => this.movesMenu(handlers, opts)),
      btn("포획", opts.canCapture ? `볼 ${opts.orbs}개 · 직접 던지기` : "불가", "catch", handlers.capture, !opts.canCapture || opts.orbs === 0),
      btn("가방", "회복·아이템", "", handlers.bag),
      btn("교체", "파티", "", handlers.party),
      btn("도망친다", opts.canRun ? "" : "불가", "back", handlers.run, !opts.canRun),
    );
  }

  movesMenu(handlers: BattleMenuHandlers, opts: { canCapture: boolean; canRun: boolean; moves: MoveSlot[]; orbs: number }): void {
    const buttons = opts.moves.map((m, i) => {
      const def = this.db.moves.get(m.id);
      const b = h(
        "button",
        { disabled: m.pp <= 0 && opts.moves.some((x) => x.pp > 0), onclick: () => handlers.fight(i), "data-move": m.id },
        def?.name ?? m.id,
        h("small", null, `${this.db.typeName(def?.type ?? "normal")} · PP ${m.pp}/${def?.pp ?? "?"}${def && def.power ? ` · 위력 ${def.power}` : ""}`),
      );
      if (def) b.style.borderColor = this.db.typeColor(def.type);
      return b;
    });
    this.menu.replaceChildren(...buttons, h("button", { class: "back", onclick: () => this.rootMenu(handlers, opts) }, "← 돌아가기"));
  }
}
