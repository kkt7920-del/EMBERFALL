import "./ui/styles.css";
import { Game } from "./engine/Game";
import { loadContent } from "./content";
import { Device, lockBrowserGestures } from "./mobile/Device";
import { LocalConnection } from "./network/LocalGameServer";
import { WsConnection, serverUrl } from "./network/WsConnection";
import { IndexedDbStore } from "./save/IndexedDbStore";
import { loadSettings } from "./settings";
import { h } from "./ui/dom";
import { showTitle } from "./ui/Title";

async function checkOnline(): Promise<boolean> {
  // Embedded single-player builds (e.g. a static share link) have no game server
  if (import.meta.env.VITE_EMBEDDED && !new URLSearchParams(location.search).get("server")) return false;
  const url = serverUrl().replace(/^ws/, "http").replace(/\/ws$/, "/api/health");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function loadingOverlay(root: HTMLElement) {
  const fill = h("div", { style: { width: "0%" } });
  const text = h("div", null, "불러오는 중…");
  const el = h("div", { class: "overlay", id: "loading" }, h("div", { class: "spinner" }), text, h("div", { class: "progress" }, fill));
  root.append(el);
  return {
    set: (p: number, t: string) => {
      fill.style.width = `${Math.round(p * 100)}%`;
      text.textContent = t;
    },
    remove: () => el.remove(),
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const overlayRoot = document.getElementById("overlays")!;
  lockBrowserGestures(document.body);

  if (import.meta.env.PROD && !import.meta.env.VITE_EMBEDDED && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((e) => console.warn("service worker", e));
  }

  const rotate = document.getElementById("rotate-overlay");
  if (rotate && Device.mobile) rotate.classList.add("enabled");

  let db;
  try {
    db = loadContent();
  } catch (e) {
    overlayRoot.append(h("div", { class: "overlay" }, h("h2", null, "콘텐츠 팩 오류"), h("pre", { style: { whiteSpace: "pre-wrap", textAlign: "left" } }, String(e))));
    throw e;
  }

  const store = new IndexedDbStore();
  let error: string | undefined;

  for (;;) {
    const ui = document.getElementById("ui")!;
    ui.replaceChildren();
    const save = await store.summary();
    const choice = await showTitle(overlayRoot, { save, onlineAvailable: checkOnline(), error });
    error = undefined;

    if (Device.mobile) void Device.enterFullscreen();

    const loading = loadingOverlay(overlayRoot);
    if (choice.mode === "new") await store.deletePlayer("local");
    const connection = choice.mode === "online" ? new WsConnection() : new LocalConnection(db);

    try {
      await new Promise<void>((resolve, reject) => {
        Game.create({
          canvas,
          ui,
          db,
          settings: loadSettings(),
          connection,
          name: choice.name,
          onProgress: (p, t) => loading.set(p, t),
          onExit: () => resolve(),
        })
          .then(() => loading.remove())
          .catch(reject);
      });
    } catch (e) {
      console.error(e);
      loading.remove();
      connection.close();
      error = `시작하지 못했습니다: ${(e as Error).message}`;
    }
  }
}

void boot();
