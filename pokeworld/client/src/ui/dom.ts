type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript helper: h("div", { class: "x", onclick }, "text", child) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "class") el.className = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "html") el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function hpColor(ratio: number): string {
  return ratio > 0.5 ? "var(--hp-hi)" : ratio > 0.2 ? "var(--hp-mid)" : "var(--hp-low)";
}

export function bar(ratio: number, cls = ""): HTMLDivElement {
  const fill = h("div", { style: { width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: cls ? undefined : hpColor(ratio) } });
  return h("div", { class: `bar ${cls}` }, fill);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
