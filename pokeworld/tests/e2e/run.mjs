// Runs every browser suite. Starts a Vite dev server (and builds + starts the
// production server for the PWA suite) unless URL/PROD_URL are provided.
import { spawn, spawnSync } from "node:child_process";

const procs = [];
const start = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "ignore", detached: true });
  procs.push(p);
  return p;
};
const waitFor = async (url, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
};
const cleanup = () => procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
process.on("exit", cleanup);

let url = process.env.URL;
if (!url) {
  start("npx", ["vite", "--port", "5174", "--strictPort"]);
  url = "http://localhost:5174/";
  await waitFor(url);
}
let prodUrl = process.env.PROD_URL;
if (!prodUrl) {
  spawnSync("npm", ["run", "build"], { stdio: "inherit" });
  start(process.execPath, ["--no-warnings", "dist/server/main.js"], { PORT: "8090", POKEWORLD_DB: "/tmp/pokeworld-e2e-prod.sqlite" });
  prodUrl = "http://localhost:8090/";
  await waitFor(`${prodUrl}api/health`);
}

let failed = 0;
for (const [suite, env] of [
  ["play.mjs", { URL: url }],
  ["mobile.mjs", { URL: url }],
  ["features.mjs", { URL: url }],
  // net.mjs runs its own game server on :2567, which the Vite proxy forwards /ws to
  ["net.mjs", { URL: url }],
  ["pwa.mjs", { URL: prodUrl }],
]) {
  console.log(`\n=== ${suite} ===`);
  const r = spawnSync(process.execPath, [`tests/e2e/${suite}`], { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) failed++;
}
cleanup();
console.log(failed ? `\n${failed} suite(s) failed` : "\nall browser suites passed");
process.exit(failed ? 1 : 0);
