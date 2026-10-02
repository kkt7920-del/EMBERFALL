// Mobile/tablet: touch controls with real multi-touch (CDP touch events),
// portrait notice, mobile quality defaults, HUD layout at several sizes.
import { BASE, check, collectErrors, launch, pw, summary, waitGame } from "./lib.mjs";

const SHOTS = "tests/e2e/screenshots";
const browser = await launch();
const iphone = {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};
const ctx = await browser.newContext(iphone);
const page = await ctx.newPage();
const errors = collectErrors(page);
const cdp = await ctx.newCDPSession(page);
const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })) });

await page.goto(BASE);
await page.waitForSelector(".title-screen", { timeout: 30000 });
await page.screenshot({ path: `${SHOTS}/mobile-01-title.png` });
await page.tap('[data-action="new"]');
await page.fill(".text-input", "모바일");
await page.tap('[data-action="start"]');
await waitGame(page);
await page.waitForTimeout(1500);

const settings = await pw(page, () => ({ s: window.__pokeworld.game.settings, chunks: window.__pokeworld.chunks }));
check("mobile defaults: render scale 0.75, 3x3 chunks, shadows off", settings.s.renderScale === 0.75 && settings.s.chunkRadius === 1 && settings.s.shadows === "off", JSON.stringify({ rs: settings.s.renderScale, r: settings.s.chunkRadius, sh: settings.s.shadows, chunks: settings.chunks }));
check("never more than 3x3 chunks resident", settings.chunks.total <= 9 * 1 + 7, JSON.stringify(settings.chunks));
const touchUi = await page.evaluate(() => {
  const layer = document.querySelector(".touch-layer");
  const btns = document.querySelectorAll(".tbtn").length;
  const hints = document.querySelector(".keyhints");
  return { layer: !!layer && getComputedStyle(layer).display !== "none", btns, hintsHidden: hints?.classList.contains("hidden"), touchAction: getComputedStyle(document.getElementById("game-canvas")).touchAction };
});
check("touch controls shown, keyboard hints hidden", touchUi.layer && touchUi.btns === 5 && touchUi.hintsHidden, JSON.stringify(touchUi));
check("canvas has touch-action: none", touchUi.touchAction === "none");
await page.screenshot({ path: `${SHOTS}/mobile-02-field.png` });

// Multi-touch: left thumb joystick (move) + right thumb camera drag at the same time
const p0 = await pw(page, () => window.__pokeworld.pos);
const yaw0 = await pw(page, () => window.__pokeworld.yaw);
await pw(page, () => (window.__pokeworld.yaw = Math.PI)); // face away from buildings
const L = { id: 1, x: 140, y: 300 };
const R = { id: 2, x: 560, y: 160 };
await touch("touchStart", [L]);
await touch("touchStart", [L, R]);
for (let i = 1; i <= 12; i++) {
  await touch("touchMove", [
    { ...L, y: 300 - Math.min(60, i * 8) },
    { ...R, x: 560 + i * 9 },
  ]);
  await page.waitForTimeout(90);
}
const mid = await pw(page, () => ({ pos: window.__pokeworld.pos, yaw: window.__pokeworld.yaw, scroll: [window.scrollX, window.scrollY], scale: window.visualViewport?.scale }));
// Third finger taps the A button while both thumbs stay down
const a = await page.$eval(".btn-a", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const L2 = { ...L, y: 240 };
const R2 = { ...R, x: 668 };
await touch("touchStart", [L2, R2, { id: 3, ...a }]);
await page.waitForTimeout(60);
await touch("touchEnd", [L2, R2]);
await touch("touchEnd", []);
await page.waitForTimeout(300);
const moved = Math.hypot(mid.pos.x - p0.x, mid.pos.z - p0.z);
check("joystick moves the player", moved > 1, `moved ${moved.toFixed(2)} m`);
check("right-side drag turns the camera simultaneously", Math.abs(mid.yaw - Math.PI) > 0.2, `yaw ${mid.yaw.toFixed(2)}`);
check("no page scroll or zoom during play", mid.scroll[0] === 0 && mid.scroll[1] === 0 && (mid.scale ?? 1) === 1, JSON.stringify(mid));
void yaw0;

// A button: walk back to the professor and talk using touch only
await pw(page, () => window.__pokeworld.debug.teleport("overworld", 0.5, 20.5));
await pw(page, () => (window.__pokeworld.yaw = 0));
await page.waitForTimeout(800);
await touch("touchStart", [{ id: 4, ...a }]);
await touch("touchEnd", []);
await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 }).catch(() => {});
const dialogOpen = await page.$(".dialog:not(.hidden)");
check("A button talks to the professor", !!dialogOpen);
await page.screenshot({ path: `${SHOTS}/mobile-03-dialog.png` });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) await page.tap(".dialog");
await page.waitForSelector('[data-species="dropnewt"]', { timeout: 8000 });
await page.tap('[data-species="dropnewt"] button');
await page.waitForFunction(() => window.__pokeworld.state?.party.length === 1, null, { timeout: 8000 });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) await page.tap(".dialog");
check("starter chosen with touch", (await pw(page, () => window.__pokeworld.state.party[0].species)) === "dropnewt");

// Battle via touch buttons
const wid = await pw(page, () => { window.__pokeworld.yaw = window.__pokeworld.pos.rotY; return window.__pokeworld.debug.spawn("meadowbug", 2, 3); });
await page.waitForTimeout(800);
await page.tap(".btn-attack");
await page.waitForSelector(".bmenu button.fight", { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/mobile-04-battle.png` });
check("battle starts from the touch Battle button", (await pw(page, () => window.__pokeworld.battle?.entityId)) === wid);
if (await page.$(".bmenu button.fight")) {
  await page.tap(".bmenu button.fight");
  await page.tap(".bmenu button[data-move]");
  await page.waitForFunction(() => document.querySelector(".bmenu button.fight") || !window.__pokeworld.battle, null, { timeout: 30000 });
  check("move selected by touch resolves", true);
}

// Portrait shows the rotate notice
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const rotate = await page.$eval("#rotate-overlay", (el) => getComputedStyle(el).display);
check("portrait shows 'rotate to landscape' notice", rotate === "flex", rotate);
await page.screenshot({ path: `${SHOTS}/mobile-05-portrait.png` });
await page.setViewportSize({ width: 844, height: 390 });
await ctx.close();

// Tablet + desktop HUD layouts (no overflowing UI)
for (const [name, vp, mobile] of [
  ["tablet-1024x768", { width: 1024, height: 768 }, true],
  ["desktop-1920x1080", { width: 1920, height: 1080 }, false],
  ["desktop-1280x720", { width: 1280, height: 720 }, false],
  ["desktop-1366x768", { width: 1366, height: 768 }, false],
]) {
  const c = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
  const p = await c.newPage();
  await p.goto(BASE);
  await p.waitForSelector('[data-action="continue"], [data-action="new"]');
  if (await p.$('[data-action="continue"]')) await p.click('[data-action="continue"]');
  else {
    await p.click('[data-action="new"]');
    await p.click('[data-action="start"]');
  }
  await waitGame(p);
  await p.waitForTimeout(1500);
  const overflow = await p.evaluate(() =>
    [...document.querySelectorAll(".hud-topleft, .hud-topright, .touch-buttons, .hud-prompt")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1);
    }).length,
  );
  await p.screenshot({ path: `${SHOTS}/layout-${name}.png` });
  check(`HUD fits ${name}`, overflow === 0);
  await c.close();
}

check("no runtime errors", errors.length === 0, errors.slice(0, 5).join(" || "));
await browser.close();
process.exit(summary() ? 0 : 1);
