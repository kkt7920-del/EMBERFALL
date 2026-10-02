// Multiplayer: two browsers on one Node server, then a hard server crash
// (SIGKILL) and restart: clients reconnect and resume the same player.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { BASE, check, collectErrors, launch, pw, summary, waitGame, walkTo } from "./lib.mjs";

const DB = "/tmp/claude-0/pokeworld-net-test.sqlite";
rmSync(DB, { force: true });
for (const ext of ["-wal", "-shm"]) rmSync(DB + ext, { force: true });

let server = null;
function startServer() {
  server = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "server/src/main.ts"], { env: { ...process.env, POKEWORLD_DB: DB, POKEWORLD_PORT: "2567" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => { if (!String(d).includes("ExperimentalWarning") && !String(d).includes("trace-warnings")) process.stdout.write(`[server!] ${d}`); });
  return new Promise((resolve) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch("http://localhost:2567/api/health");
        if (r.ok) {
          clearInterval(t);
          resolve();
        }
      } catch {}
    }, 300);
  });
}

async function joinOnline(browser, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // The browser itself logs failed WebSocket handshakes while the server is down on purpose
  const errors = collectErrors(page, /WebSocket connection to .* failed/);
  await page.goto(BASE);
  await page.waitForSelector('[data-action="online"]:not([disabled])', { timeout: 20000 });
  await page.click('[data-action="online"]');
  await page.fill(".text-input", name);
  await page.click('[data-action="start"]');
  await waitGame(page);
  return { page, errors };
}

await startServer();
const browser = await launch();
const a = await joinOnline(browser, "알파");
check("client A joins the online server", /온라인/.test(await pw(a.page, () => window.__pokeworld.netStatus)));

// Server-authoritative starter for A
await walkTo(a.page, 0.5, 23.5, 2.6);
await a.page.keyboard.press("KeyE");
await a.page.waitForSelector(".dialog:not(.hidden)", { timeout: 8000 });
for (let i = 0; i < 4 && (await a.page.$(".dialog:not(.hidden)")); i++) await a.page.keyboard.press("KeyE");
await a.page.click('[data-species="leafbun"]');
await a.page.waitForFunction(() => window.__pokeworld.state?.party.length === 1, null, { timeout: 8000 });
for (let i = 0; i < 4 && (await a.page.$(".dialog:not(.hidden)")); i++) await a.page.keyboard.press("KeyE");
const idA = await pw(a.page, () => window.__pokeworld.game.playerId);
check("server grants the starter to A", (await pw(a.page, () => window.__pokeworld.state.party[0].species)) === "leafbun");

// Client cannot teleport: the server corrects an impossible move
await pw(a.page, () => window.__pokeworld.game.connection.send({ type: "PLAYER_MOVE", seq: 99999, x: 400, y: 30, z: 400, rotY: 0, anim: "run" }));
await a.page.waitForTimeout(800);
const posA = await pw(a.page, () => window.__pokeworld.pos);
check("server rejects a teleporting client", Math.hypot(posA.x, posA.z) < 60, JSON.stringify(posA));

// Second player shares the world
const b = await joinOnline(browser, "베타");
await a.page.waitForTimeout(2500);
const seenByA = await pw(a.page, () => window.__pokeworld.remotes);
const seenByB = await pw(b.page, () => window.__pokeworld.remotes);
check("players see each other in the same world", seenByA.some((r) => r.name === "베타") && seenByB.some((r) => r.name === "알파"), `${JSON.stringify(seenByA)} / ${JSON.stringify(seenByB)}`);
await a.page.screenshot({ path: "tests/e2e/screenshots/net-01-two-players.png" });

// Hard crash
server.kill("SIGKILL");
await a.page.waitForSelector("#reconnect-overlay:not(.hidden)", { timeout: 15000 }).catch(() => {});
check("disconnect shows the reconnect overlay", !!(await a.page.$("#reconnect-overlay:not(.hidden)")));
await a.page.screenshot({ path: "tests/e2e/screenshots/net-02-reconnecting.png" });
await a.page.waitForTimeout(2000);

await startServer();
await a.page.waitForSelector("#reconnect-overlay.hidden", { state: "attached", timeout: 40000 }).catch(() => {});
await a.page.waitForFunction(() => /온라인/.test(window.__pokeworld?.netStatus ?? ""), null, { timeout: 40000 }).catch(() => {});
check("client reconnects automatically after the server returns", /온라인/.test(await pw(a.page, () => window.__pokeworld.netStatus)));
const idA2 = await pw(a.page, () => window.__pokeworld.game.playerId);
check("same player resumed (id + token)", idA2 === idA, `${idA} -> ${idA2}`);
check("server-side save survived the crash", (await pw(a.page, () => window.__pokeworld.state.party[0]?.species)) === "leafbun");
const moved = await pw(a.page, () => window.__pokeworld.pos);
check("game keeps running after reconnect", Number.isFinite(moved.x));

check("no runtime errors (A)", a.errors.length === 0, a.errors.slice(0, 4).join(" || "));
check("no runtime errors (B)", b.errors.length === 0, b.errors.slice(0, 4).join(" || "));
await browser.close();
server.kill("SIGTERM");
process.exit(summary() ? 0 : 1);
