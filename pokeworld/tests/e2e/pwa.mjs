// PWA: manifest, service worker registration and offline app shell (production build).
import { check, launch, summary } from "./lib.mjs";
const URL = process.env.URL ?? "http://localhost:8080/";
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(URL);
await page.waitForSelector(".title-screen");
const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
check("manifest: fullscreen + landscape + icons", manifest.display === "fullscreen" && manifest.orientation === "landscape" && manifest.icons.some((i) => i.purpose === "maskable"), JSON.stringify({ d: manifest.display, o: manifest.orientation, n: manifest.icons.length }));
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return { scope: reg.scope, active: !!reg.active };
});
check("service worker registers", sw.active, JSON.stringify(sw));
await page.reload();
await page.waitForSelector(".title-screen");
check("page is controlled by the service worker", await page.evaluate(() => !!navigator.serviceWorker.controller));
await ctx.setOffline(true);
await page.reload();
const offlineOk = await page.waitForSelector(".title-screen", { timeout: 15000 }).then(() => true).catch(() => false);
check("app shell loads offline (single player still available)", offlineOk);
await browser.close();
process.exit(summary() ? 0 : 1);
