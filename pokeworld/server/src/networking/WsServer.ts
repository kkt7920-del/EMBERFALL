import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { parseClientMessage, type ServerMessage } from "@shared/protocol/messages";
import type { Simulation } from "../sim/Simulation";

const MAX_MESSAGE_BYTES = 8 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;

/** WebSocket transport for the shared Simulation. One socket = one player. */
export function attachWebSocketServer(http: Server, sim: Simulation, log: (m: string) => void): WebSocketServer {
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let playerId: string | null = null;
    let joining = false;
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    const send = (msg: ServerMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const helloTimer = setTimeout(() => {
      if (!playerId) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = parseClientMessage(raw);
      if (!msg) return;

      if (!playerId) {
        if (msg.type !== "HELLO" || joining) return;
        joining = true;
        const player = await sim.join({ send }, msg);
        joining = false;
        if (!player) return ws.close(4002, "join refused");
        playerId = player.id;
        clearTimeout(helloTimer);
        return;
      }
      sim.handle(playerId, msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (playerId) void sim.leave(playerId);
    });
    ws.on("error", (e) => log(`ws error from ${req.socket.remoteAddress}: ${e.message}`));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
