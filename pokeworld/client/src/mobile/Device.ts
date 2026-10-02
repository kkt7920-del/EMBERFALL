/** Device capabilities that drive the default control scheme and quality preset. */
export const Device = {
  get touch(): boolean {
    return matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  },

  get mobile(): boolean {
    const ua = navigator.userAgent;
    const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS || (matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches);
  },

  get iOS(): boolean {
    const ua = navigator.userAgent;
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  },

  get portrait(): boolean {
    return window.innerHeight > window.innerWidth;
  },

  get standalone(): boolean {
    return matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || (navigator as { standalone?: boolean }).standalone === true;
  },

  async enterFullscreen(): Promise<void> {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    try {
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await orientation?.lock?.("landscape").catch(() => {});
    } catch {
      // iOS Safari has no element fullscreen; the PWA runs fullscreen when installed
    }
  },
};

/**
 * Stops the browser from scrolling, zooming, selecting or showing callouts
 * while playing. CSS `touch-action: none` covers most of it; iOS Safari
 * additionally needs the gesture/touch events cancelled.
 */
export function lockBrowserGestures(root: HTMLElement): void {
  const prevent = (e: Event) => {
    if ((e.target as HTMLElement)?.closest?.("[data-allow-scroll]")) return;
    e.preventDefault();
  };
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, prevent, { passive: false });
  root.addEventListener("touchmove", prevent, { passive: false });
  root.addEventListener("contextmenu", (e) => e.preventDefault());
  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    (e) => {
      // Block double-tap zoom on the game surface only; buttons/inputs use
      // `touch-action: manipulation` and must keep their click events.
      const now = Date.now();
      const interactive = (e.target as HTMLElement)?.closest?.("button, input, textarea, a, [data-action], .card, .dialog, .bmessage");
      if (now - lastTouchEnd < 300 && !interactive) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );
  document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
}
