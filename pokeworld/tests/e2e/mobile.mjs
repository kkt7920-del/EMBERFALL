// Mobile/tablet: touch controls with real multi-touch (CDP touch events),
// portrait notice, mobile quality defaults, HUD layout at several sizes.
import { BASE, check, collectErrors, launch, pw, summary, waitGame, waitSound } from "./lib.mjs";

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
check("mobile defaults: render scale 0.75, 5x5 chunks, 1 LOD ring, shadows off", settings.s.renderScale === 0.75 && settings.s.chunkRadius === 2 && settings.s.lodTiles === 1 && settings.s.shadows === "off", JSON.stringify({ rs: settings.s.renderScale, r: settings.s.chunkRadius, sh: settings.s.shadows, chunks: settings.chunks }));
check("never more than the 5x5 square (+ unload ring) resident", settings.chunks.total <= 49, JSON.stringify(settings.chunks));
const touchUi = await page.evaluate(() => {
  const layer = document.querySelector(".touch-layer");
  const btns = document.querySelectorAll(".tbtn").length;
  const hints = document.querySelector(".keyhints");
  return { layer: !!layer && getComputedStyle(layer).display !== "none", btns, hintsHidden: hints?.classList.contains("hidden"), touchAction: getComputedStyle(document.getElementById("game-canvas")).touchAction };
});
check("touch controls shown (incl. BALL), keyboard hints hidden", touchUi.layer && touchUi.btns === 5 && !!(await page.$(".tbtn.btn-ball")) && touchUi.hintsHidden, JSON.stringify(touchUi));
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
await pw(page, () => window.__pokeworld.debug.teleport(0.5, 20.5));
await pw(page, () => (window.__pokeworld.yaw = 0));
await page.waitForTimeout(800);
await touch("touchStart", [{ id: 4, ...a }]);
await touch("touchEnd", []);
await page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 }).catch(() => {});
const dialogOpen = await page.$(".dialog:not(.hidden)");
check("A button talks to the professor", !!dialogOpen);
await page.screenshot({ path: `${SHOTS}/mobile-03-dialog.png` });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) await page.tap(".dialog");
await page.waitForSelector('[data-species="squirtle"]', { timeout: 8000 });
await page.tap('[data-species="squirtle"] button');
await page.waitForFunction(() => window.__pokeworld.state?.party.length === 1, null, { timeout: 8000 });
for (let i = 0; i < 4 && (await page.$(".dialog:not(.hidden)")); i++) await page.tap(".dialog");
check("starter chosen with touch", (await pw(page, () => window.__pokeworld.state.party[0].species)) === "squirtle");

// Battle via touch buttons
const wid = await pw(page, () => { window.__pokeworld.yaw = window.__pokeworld.pos.rotY; return window.__pokeworld.debug.spawn("geodude", 3, 3); });
await page.waitForTimeout(800);
await page.tap(".btn-attack");
await page.waitForSelector(".bmenu button.fight", { timeout: 20000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/mobile-04-battle.png` });
const bInfo = await pw(page, (wid) => ({ battle: window.__pokeworld.battle?.entityId ?? null, target: window.__pokeworld.target, c: window.__pokeworld.creatures().find((c) => c.id === wid) ?? null, pos: window.__pokeworld.pos, toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent) }), wid);
check("battle starts from the touch Battle button", bInfo.battle === wid, JSON.stringify(bInfo));
if (await page.$(".bmenu button.fight")) {
  await page.tap(".bmenu button.fight");
  await page.tap(".bmenu button[data-move]");
  await page.waitForFunction(() => document.querySelector(".bmenu button.fight") || !window.__pokeworld.battle, null, { timeout: 30000 });
  check("move selected by touch resolves", true);
}

// Leave the battle (도망친다) so the field tests can continue
for (let i = 0; i < 10 && (await pw(page, () => !!window.__pokeworld.battle)); i++) {
  const run = await page.$(".bmenu button.back");
  if (run) await page.tap(".bmenu button.back").catch(() => {});
  else if (await page.$(".bmessage")) await page.tap(".bmessage").catch(() => {});
  await page.waitForTimeout(1500);
}
check("running away ends the battle", !(await pw(page, () => !!window.__pokeworld.battle)));
await ballFlow(page, touch, "iphone");

// Portrait shows the rotate notice
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const rotate = await page.$eval("#rotate-overlay", (el) => getComputedStyle(el).display);
check("portrait shows 'rotate to landscape' notice", rotate === "flex", rotate);
await page.screenshot({ path: `${SHOTS}/mobile-05-portrait.png` });
await page.setViewportSize({ width: 844, height: 390 });
await ctx.close();

// Android phone (landscape): the same touch throwing flow
{
  const actx = await browser.newContext({
    viewport: { width: 915, height: 412 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  });
  const ap = await actx.newPage();
  const aerr = collectErrors(ap);
  const acdp = await actx.newCDPSession(ap);
  const atouch = (type, points) => acdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })) });
  await ap.goto(BASE);
  await ap.waitForSelector(".title-screen", { timeout: 30000 });
  await ap.tap('[data-action="new"]');
  await ap.fill(".text-input", "안드로이드");
  await ap.tap('[data-action="start"]');
  await waitGame(ap);
  await ballFlow(ap, atouch, "android");
  check("android: no runtime errors", aerr.length === 0, aerr.slice(0, 3).join(" || "));
  await actx.close();
}

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
    [...document.querySelectorAll(".hud-topleft, .hud-topright, .touch-buttons, .hud-prompt, .ball-dock")].filter((el) => {
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

/**
 * Touch throwing (TEST 13): tap BALL = ball in hand, right-side drag aims, the
 * joystick still moves while aiming, hold BALL = charge, release = throw; the
 * chip opens the Ball Wheel; long-press on a Pokémon shows its info.
 */
async function ballFlow(page, touch, name) {
  const g = (fn, a) => pw(page, fn, a);
  const center = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await g(() => { const d = window.__pokeworld.debug; d.give("poke_ball", 5); d.setHour(10); d.teleport(30, -40); });
  await page.waitForTimeout(5000);
  const ball = await center(".btn-ball");
  await touch("touchStart", [{ id: 11, ...ball }]);
  await page.waitForTimeout(80);
  await touch("touchEnd", []);
  await page.waitForFunction(() => window.__pokeworld.aim.equipped, null, { timeout: 5000 }).catch(() => {});
  check(`${name}: tapping BALL takes a ball in hand`, await g(() => window.__pokeworld.aim.equipped));

  const id = await g(() => window.__pokeworld.debug.spawn("pikachu", 8, 7, { hpFraction: 0.3 }));
  await page.waitForTimeout(1500);
  const vw = await g(() => innerWidth);
  const yaw0 = await g(() => window.__pokeworld.yaw);
  const R = { id: 12, x: Math.round(vw * 0.7), y: 200 };
  await touch("touchStart", [R]);
  for (let i = 1; i <= 8; i++) {
    await touch("touchMove", [{ ...R, x: R.x + i * 10 }]);
    await page.waitForTimeout(60);
  }
  await touch("touchEnd", []);
  const yaw1 = await g(() => window.__pokeworld.yaw);
  check(`${name}: right-side drag aims the camera`, Math.abs(yaw1 - yaw0) > 0.05, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);

  const p0 = await g(() => window.__pokeworld.pos);
  const L = { id: 13, x: 140, y: 300 };
  await touch("touchStart", [L]);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", [{ ...L, x: 140 + Math.min(50, i * 8) }]);
    await page.waitForTimeout(80);
  }
  await touch("touchEnd", []);
  const p1 = await g(() => window.__pokeworld.pos);
  check(`${name}: the joystick moves while aiming`, Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.3 && (await g(() => window.__pokeworld.aim.equipped)));

  // Long-press on the Pokémon: quick info (name, Lv, type, HP, gender, status)
  const { aimAt } = await import("./lib.mjs");
  const locked = await aimAt(page, id);
  const mid = { id: 14, x: Math.round(vw / 2), y: Math.round((await g(() => innerHeight)) / 2) };
  await touch("touchStart", [mid]);
  await page.waitForTimeout(700);
  await touch("touchEnd", []);
  const info = await page.waitForSelector(".modal", { timeout: 4000 }).then(() => page.$eval(".modal", (el) => el.textContent)).catch(() => "");
  check(`${name}: long-press shows Pokémon info`, /Pikachu/.test(info) && /Lv\. 8/.test(info), info.slice(0, 80));
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-info.png` });
  if (await page.$(".modal")) await page.tap(".modal .btn:not(.btn-primary)").catch(() => page.keyboard.press("Escape"));
  await page.waitForTimeout(300);

  // A fresh (idle) Pokémon for the throw itself
  const id2 = await g(() => window.__pokeworld.debug.spawn("pikachu", 8, 6, { hpFraction: 0.3 }));
  await page.waitForTimeout(1500);
  await aimAt(page, id2);
  check(`${name}: reticle locks on with name/Lv`, locked && /Lv\. 8/.test((await page.textContent(".aim-label")) ?? ""));
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-aim.png` });
  await g(() => window.__pokeworld.debug.forceCapture("success"));
  const s0 = await g(() => window.__pokeworld.sounds.length);
  console.log(name, "pre-throw", JSON.stringify(await g((id) => ({ aim: window.__pokeworld.aim.target, yaw: window.__pokeworld.yaw, c: window.__pokeworld.creatures().find((c) => c.id === id), p: window.__pokeworld.pos }), id2)));
  await touch("touchStart", [{ id: 15, ...ball }]);
  const ring = await page.waitForSelector(".power-ring:not(.hidden)", { timeout: 5000 }).then(() => true).catch(() => false);
  console.log(name, "charging", JSON.stringify(await g(() => ({ aim: window.__pokeworld.aim.target, yaw: window.__pokeworld.yaw }))));
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-charge.png` });
  await touch("touchEnd", []);
  const snd = await waitSound(page, s0, ["capture_success", "capture_breakout"]);
  console.log(name, "throw", JSON.stringify(await g(() => window.__pokeworld.aim.last)), JSON.stringify(await g((id) => window.__pokeworld.creatures().find((c) => c.id === id), id)), JSON.stringify(await g(() => window.__pokeworld.pos)));
  check(`${name}: hold BALL charges, release throws, the Pokémon is caught`, ring && snd.includes("ball_throw") && snd.includes("capture_success"), snd.join(","));
  await page.waitForTimeout(2500);
  check(`${name}: the catch joins the party`, (await g(() => window.__pokeworld.state.party.map((c) => c.species))).includes("pikachu"));

  await touch("touchStart", [{ id: 16, ...(await center(".ball-chip")) }]);
  await touch("touchEnd", []);
  const wheel = await page.waitForSelector(".ball-wheel", { timeout: 4000 }).then(() => true).catch(() => false);
  await page.screenshot({ path: `${SHOTS}/mobile-${name}-wheel.png` });
  check(`${name}: the ball chip opens the Ball Wheel`, wheel);
  if (wheel) await page.tap(".wheel-center");
}
