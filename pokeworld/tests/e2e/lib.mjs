import { chromium } from "playwright";

export const BASE = process.env.URL ?? "http://localhost:5173/";
export const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export async function launch() {
  return chromium.launch({ args: GL_ARGS });
}

export function collectErrors(page, expected = /$^/) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // 500 = /api/health probe through the Vite proxy when no game server is running
    if (m.type() === "error" && !/status of 500|Failed to load resource/.test(m.text()) && !expected.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

export async function waitGame(page, timeout = 90000) {
  await page.waitForFunction(() => !document.getElementById("loading") && window.__pokeworld && window.__pokeworld.chunks.loaded > 0, null, { timeout });
}

export const pw = (page, fn, arg) => page.evaluate(fn, arg);

export async function newGame(page, name = "테스터") {
  await page.goto(BASE);
  await page.waitForSelector(".title-screen", { timeout: 30000 });
  await page.click('[data-action="new"]');
  await page.fill(".text-input", name);
  await page.click('[data-action="start"]');
  // Overwriting an existing save asks for a second press
  if (await page.waitForSelector(".title-screen", { state: "detached", timeout: 1500 }).then(() => false).catch(() => true)) await page.click('[data-action="start"]');
  await waitGame(page);
}

/** Turns the camera toward a world point and holds W until within `dist` metres. */
export async function walkTo(page, x, z, dist = 2.5, maxMs = 15000) {
  const start = Date.now();
  await page.keyboard.down("KeyW");
  try {
    while (Date.now() - start < maxMs) {
      const p = await pw(page, () => window.__pokeworld.pos);
      const dx = x - p.x;
      const dz = z - p.z;
      if (Math.hypot(dx, dz) < dist) return true;
      await pw(page, (yaw) => (window.__pokeworld.yaw = yaw), Math.atan2(dx, dz));
      await page.waitForTimeout(120);
    }
    return false;
  } finally {
    await page.keyboard.up("KeyW");
  }
}

/** Like walkTo, but follows a wild creature that may be wandering. */
export async function walkToCreature(page, id, dist = 2.5, maxMs = 20000) {
  const start = Date.now();
  await page.keyboard.down("KeyW");
  try {
    while (Date.now() - start < maxMs) {
      const [p, c] = await pw(page, (id) => [window.__pokeworld.pos, window.__pokeworld.creatures().find((w) => w.id === id)], id);
      if (!c) return false;
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      if (Math.hypot(dx, dz) < dist) return true;
      await pw(page, (yaw) => (window.__pokeworld.yaw = yaw), Math.atan2(dx, dz));
      await page.waitForTimeout(100);
    }
    return false;
  } finally {
    await page.keyboard.up("KeyW");
  }
}

export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}
