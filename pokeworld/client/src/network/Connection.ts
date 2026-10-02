import type { ClientMessage, ServerMessage } from "@shared/protocol/messages";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * What the game talks to. Single player (LocalConnection) and multiplayer
 * (WsConnection) implement the same interface and the same protocol.
 */
export interface GameConnection {
  readonly mode: "local" | "online";
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  connect(name: string): Promise<void>;
  send(msg: ClientMessage): void;
  close(): void;
}
