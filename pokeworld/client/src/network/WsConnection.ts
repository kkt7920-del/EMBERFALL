import { PROTOCOL_VERSION } from "@shared/config/constants";
import type { ClientMessage, ServerMessage } from "@shared/protocol/messages";
import type { ConnectionStatus, GameConnection } from "./Connection";

const IDENTITY_KEY = "pokeworld.online.identity";

interface Identity {
  playerId?: string;
  token?: string;
}

function loadIdentity(): Identity {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "{}") as Identity;
  } catch {
    return {};
  }
}

function saveIdentity(i: Identity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(i));
  } catch {
    // ignore
  }
}

/** Server URL: ?server=wss://host/ws, VITE_SERVER_URL, or same origin /ws. */
export function serverUrl(): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param) return param;
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

/**
 * Multiplayer transport. Reconnects with exponential backoff and resumes the
 * same player using the id/token the server issued on first join.
 */
export class WsConnection implements GameConnection {
  readonly mode = "online" as const;
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: ConnectionStatus, detail?: string) => void = () => {};

  private ws: WebSocket | null = null;
  private name = "";
  private intentionalClose = false;
  private attempt = 0;
  private outbox: ClientMessage[] = [];
  private welcomed = false;
  private retryTimer: number | null = null;

  constructor(private readonly url = serverUrl()) {}

  connect(name: string): Promise<void> {
    this.name = name;
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      this.open(
        () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        },
      );
    });
  }

  private open(onWelcome?: () => void, onFirstFail?: (e: Error) => void): void {
    this.onStatus(this.attempt === 0 ? "connecting" : "reconnecting", this.attempt ? `${this.attempt}번째 재시도` : undefined);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      onFirstFail?.(e as Error);
      return;
    }
    this.ws = ws;
    this.welcomed = false;

    ws.onopen = () => {
      const id = loadIdentity();
      ws.send(JSON.stringify({ type: "HELLO", protocol: PROTOCOL_VERSION, name: this.name, playerId: id.playerId, token: id.token } satisfies ClientMessage));
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "WELCOME") {
        saveIdentity({ playerId: msg.playerId, token: msg.token });
        this.welcomed = true;
        this.attempt = 0;
        this.onStatus("open");
        const queued = this.outbox;
        this.outbox = [];
        for (const m of queued) this.send(m);
        onWelcome?.();
        onWelcome = undefined;
      }
      if (msg.type === "ERROR" && msg.code === "protocol") this.intentionalClose = true;
      this.onMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.intentionalClose) {
        this.onStatus("closed");
        return;
      }
      if (onWelcome && this.attempt >= 2) {
        // Never got in: let the title screen show the error
        onFirstFail?.(new Error("서버에 연결할 수 없습니다."));
        onWelcome = undefined;
        this.onStatus("closed");
        return;
      }
      this.attempt++;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt);
      this.onStatus("reconnecting", `${Math.round(delay / 1000)}초 후 재연결`);
      this.retryTimer = window.setTimeout(() => this.open(onWelcome, onFirstFail), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.welcomed) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== "PLAYER_MOVE" && msg.type !== "PLAYER_ROTATE" && msg.type !== "PING") this.outbox.push(msg);
  }

  /** Test hook: drop the socket as if the network failed. */
  simulateDrop(): void {
    this.ws?.close();
  }

  close(): void {
    this.intentionalClose = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.ws?.close();
  }
}
