import { h } from "./dom";

/** Bottom-of-screen speech box. Tap / click / E / Space / Enter advances. */
export class Dialog {
  private readonly el: HTMLDivElement;
  private readonly speaker: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private queue: { speaker: string; lines: string[]; resolve: () => void }[] = [];
  private current: { speaker: string; lines: string[]; index: number; resolve: () => void } | null = null;

  constructor(root: HTMLElement) {
    this.speaker = h("div", { class: "dialog-speaker" });
    this.text = h("div", { class: "dialog-text" });
    this.el = h("div", { class: "dialog hidden", onclick: () => this.advance() }, this.speaker, this.text, h("div", { class: "dialog-next" }, "▼"));
    root.appendChild(this.el);
    window.addEventListener("keydown", (e) => {
      if (!this.current) return;
      if (e.code === "KeyE" || e.code === "Space" || e.code === "Enter" || e.code === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.advance();
      }
    }, true);
  }

  get open(): boolean {
    return this.current !== null;
  }

  show(speaker: string, lines: string[]): Promise<void> {
    return new Promise((resolve) => {
      const usable = lines.filter((l) => l && l.trim());
      if (usable.length === 0) return resolve();
      this.queue.push({ speaker, lines: usable, resolve });
      if (!this.current) this.next();
    });
  }

  private next(): void {
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.el.classList.add("hidden");
      return;
    }
    this.current = { ...item, index: 0 };
    this.el.classList.remove("hidden");
    this.render();
  }

  private render(): void {
    if (!this.current) return;
    this.speaker.textContent = this.current.speaker;
    this.speaker.classList.toggle("hidden", !this.current.speaker);
    this.text.textContent = this.current.lines[this.current.index];
  }

  advance(): void {
    if (!this.current) return;
    this.current.index++;
    if (this.current.index >= this.current.lines.length) {
      const done = this.current.resolve;
      this.current = null;
      done();
      this.next();
    } else this.render();
  }
}
