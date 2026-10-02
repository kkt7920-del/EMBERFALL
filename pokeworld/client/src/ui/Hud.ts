import type { Action } from "../engine/Input";
import { bar, h } from "./dom";

export interface LeadInfo {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  color: string;
}

const BUTTONS: { action: Action; icon: string; label: string; key: string }[] = [
  { action: "party", icon: "◓", label: "파티", key: "P" },
  { action: "bag", icon: "🎒", label: "가방", key: "B" },
  { action: "map", icon: "🗺", label: "지도", key: "M" },
  { action: "menu", icon: "☰", label: "메뉴", key: "Q" },
];

export class Hud {
  readonly el: HTMLDivElement;
  private readonly location: HTMLDivElement;
  private readonly meta: HTMLDivElement;
  private readonly quest: HTMLDivElement;
  private readonly lead: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly tag: HTMLDivElement;
  private readonly toasts: HTMLDivElement;
  private readonly fps: HTMLDivElement;
  private readonly net: HTMLDivElement;
  private readonly hints: HTMLDivElement;
  onAction: (a: Action) => void = () => {};
  private lastQuest = "";
  private lastLead = "";

  constructor(root: HTMLElement) {
    this.location = h("div", { class: "chip hud-location" }, "");
    this.meta = h("div", { class: "chip hud-meta" });
    this.lead = h("div", { class: "chip hud-lead hidden" });
    this.quest = h("div", { class: "chip hud-quest hidden" });
    this.prompt = h("div", { class: "hud-prompt hidden", onclick: () => this.onAction("interact") });
    this.tag = h("div", { class: "target-tag hidden" });
    this.toasts = h("div", { class: "toasts" });
    this.fps = h("div", { class: "fps hidden" });
    this.net = h("div", { class: "hud-net" });
    this.hints = h(
      "div",
      { class: "keyhints hidden" },
      h("div", { html: "<kbd>WASD</kbd> 이동 <kbd>Shift</kbd> 달리기 <kbd>Space</kbd> 점프 <kbd>마우스</kbd> 카메라" }),
      h("div", { html: "<kbd>E</kbd> 대화·조사 <kbd>F</kbd> 배틀 <kbd>R</kbd> 포획구 던지기 <kbd>T</kbd> 탑승" }),
    );

    const buttons = h(
      "div",
      { class: "hud-topright" },
      ...BUTTONS.map((b) =>
        h(
          "button",
          { class: "hud-btn", "data-action": b.action, onclick: () => this.onAction(b.action) },
          h("span", { class: "icon" }, b.icon),
          h("span", null, b.label),
          h("kbd", null, b.key),
        ),
      ),
    );

    this.el = h(
      "div",
      { class: "hud" },
      h("div", { class: "hud-topleft" }, this.location, this.meta, this.lead, this.quest),
      buttons,
      this.prompt,
      this.tag,
      this.toasts,
      this.fps,
      h("div", { class: "hud-bottomleft" }, this.hints),
      this.net,
    );
    root.appendChild(this.el);
  }

  setVisible(on: boolean): void {
    this.el.classList.toggle("hidden", !on);
  }

  setLocation(text: string): void {
    if (this.location.textContent !== text) this.location.textContent = text;
  }

  setMeta(time: string, weather: string, money: number): void {
    const html = `<span>${time}</span><span>${weather}</span><span>💰 ${money.toLocaleString()}원</span>`;
    if (this.meta.innerHTML !== html) this.meta.innerHTML = html;
  }

  setLead(lead: LeadInfo | null): void {
    const key = lead ? `${lead.name}|${lead.level}|${lead.hp}|${lead.maxHp}` : "";
    if (key === this.lastLead) return;
    this.lastLead = key;
    this.lead.classList.toggle("hidden", !lead);
    if (!lead) return;
    this.lead.replaceChildren(
      h("div", { class: "swatch", style: { background: lead.color } }),
      h("div", { class: "info" }, h("div", null, `${lead.name}  Lv.${lead.level}`), bar(lead.hp / lead.maxHp)),
    );
  }

  setQuest(html: string): void {
    if (html === this.lastQuest) return;
    this.lastQuest = html;
    this.quest.classList.toggle("hidden", !html);
    this.quest.innerHTML = html;
  }

  showPrompt(text: string | null, key: string): void {
    this.prompt.classList.toggle("hidden", !text);
    if (text) {
      const html = `<kbd>${key}</kbd>${text}`;
      if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html;
    }
  }

  showTarget(x: number, y: number, text: string | null, wild: boolean): void {
    this.tag.classList.toggle("hidden", !text);
    if (!text) return;
    this.tag.textContent = text;
    this.tag.classList.toggle("wild", wild);
    this.tag.style.left = `${x}px`;
    this.tag.style.top = `${y}px`;
  }

  toast(text: string, tone: "info" | "good" | "bad" | "legend" = "info"): void {
    const t = h("div", { class: `toast ${tone}` }, text);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild?.remove();
    setTimeout(() => t.remove(), 4100);
  }

  setFps(fps: number | null): void {
    this.fps.classList.toggle("hidden", fps === null);
    if (fps !== null) this.fps.textContent = `${fps.toFixed(0)} FPS`;
  }

  setNet(text: string): void {
    if (this.net.textContent !== text) this.net.textContent = text;
  }

  setKeyHints(on: boolean): void {
    this.hints.classList.toggle("hidden", !on);
  }
}
