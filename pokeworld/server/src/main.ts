import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TICK_RATE } from "@shared/config/constants";
import { attachWebSocketServer } from "./networking/WsServer";
import { loadContentFromDisk } from "./persistence/contentLoader";
import { SqliteStore } from "./persistence/SqliteStore";
import { Simulation } from "./sim/Simulation";

const here = fileURLToPath(new URL(".", import.meta.url));
// Works from server/src (tsx) and from dist/server (bundled)
const projectRoot = [resolve(here, "../.."), resolve(here, "..", "..", "..")].find((p) => existsSync(join(p, "content"))) ?? process.cwd();

const PORT = Number(process.env.PORT ?? process.env.POKEWORLD_PORT ?? 2567);
const CONTENT_DIR = process.env.POKEWORLD_CONTENT ?? join(projectRoot, "content");
const DB_PATH = process.env.POKEWORLD_DB ?? join(projectRoot, "data", "pokeworld.sqlite");
const STATIC_DIR = process.env.POKEWORLD_STATIC ?? join(projectRoot, "dist", "client");

const log = (m: string) => console.log(`[pokeworld] ${new Date().toISOString()} ${m}`);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

async function main() {
  const db = loadContentFromDisk(CONTENT_DIR);
  log(`content: ${db.species.size} species, ${db.moves.size} moves, ${db.spawns.length} spawn rules`);

  const store = new SqliteStore(DB_PATH);
  const sim = new Simulation({ db, store, multiplayer: true, log });
  await sim.init();

  const serveStatic = existsSync(join(STATIC_DIR, "index.html"));

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, players: sim.playerCount, creatures: sim.creatureCount, clock: sim.clock() }));
      return;
    }
    if (!serveStatic) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("PokeWorld game server. Client is served by Vite in development (npm run dev).");
      return;
    }
    // Static client (production). Unknown paths fall back to index.html.
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(STATIC_DIR, safe);
    if (!file.startsWith(STATIC_DIR) || !existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, "index.html");
    const ext = extname(file);
    const immutable = file.includes(`${join(STATIC_DIR, "assets")}`);
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(readFileSync(file));
  });

  attachWebSocketServer(http, sim, log);

  const interval = setInterval(() => sim.tick(), 1000 / TICK_RATE);

  http.listen(PORT, () => log(`listening on :${PORT} (ws path /ws${serveStatic ? ", serving client" : ""})`));

  const shutdown = async (signal: string) => {
    log(`${signal}: saving and shutting down`);
    clearInterval(interval);
    await sim.shutdown();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
