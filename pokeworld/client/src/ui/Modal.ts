import { h } from "./dom";

let active: { close: () => void } | null = null;

export function modalOpen(): boolean {
  return active !== null;
}

export function closeModal(): void {
  active?.close();
}

/** Opens a single modal panel (closing any previous one). */
export function openModal(title: string, body: HTMLElement, onClose?: () => void, root: HTMLElement = document.getElementById("ui")!): { close: () => void; body: HTMLElement } {
  active?.close();
  const closeBtn = h("button", { class: "modal-close", "aria-label": "닫기" }, "✕");
  const content = h("div", { class: "modal-body", "data-allow-scroll": "" }, body);
  const modal = h("div", { class: "modal", role: "dialog" }, h("div", { class: "modal-head" }, h("span", null, title), closeBtn), content);
  const backdrop = h("div", { class: "modal-backdrop" }, modal);
  let closed = false;
  const handle = {
    body: content,
    close: () => {
      if (closed) return;
      closed = true;
      backdrop.remove();
      window.removeEventListener("keydown", onKey, true);
      if (active === handle) active = null;
      onClose?.();
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      handle.close();
    }
  };
  closeBtn.addEventListener("click", handle.close);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) handle.close();
  });
  window.addEventListener("keydown", onKey, true);
  root.appendChild(backdrop);
  active = handle;
  return handle;
}
