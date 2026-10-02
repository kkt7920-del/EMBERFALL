import type { BattleAction, BattleEvent, BattleOutcome, BattleView } from "../types/battle";
import type {
  AnimState,
  CreatureAnim,
  CreatureInstance,
  PlayerPrivateState,
  PlayerSnapshot,
  QuestState,
  WildSnapshot,
  WorldClock,
} from "../types/game";

/**
 * Wire protocol. The same messages flow over WebSocket (multiplayer) and the
 * in-memory LocalGameServer (single player), so both modes run one code path.
 *
 * The client only *requests*; the server decides capture success, damage,
 * spawns, rewards, quest completion and inventory results.
 */

export type PlayerAction =
  | { kind: "interact"; target: string }
  | { kind: "battle"; target: string }
  | { kind: "choose_starter"; species: string }
  | { kind: "buy"; item: string; count: number }
  | { kind: "use_item"; item: string; partyIndex: number }
  | { kind: "party_swap"; a: number; b: number }
  | { kind: "mount"; on: boolean }
  | { kind: "save" };

export type ClientMessage =
  | { type: "HELLO"; protocol: number; name: string; playerId?: string; token?: string }
  | { type: "PLAYER_MOVE"; seq: number; x: number; y: number; z: number; rotY: number; anim: AnimState }
  | { type: "PLAYER_ROTATE"; rotY: number }
  | { type: "PLAYER_ACTION"; action: PlayerAction }
  | { type: "BATTLE_ACTION"; battleId: string; action: BattleAction }
  /** A Poké Ball leaves the player's hand: origin and launch velocity (the server simulates the flight). */
  | { type: "BALL_THROW"; seq: number; ball: string; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { type: "PING"; t: number };

/** A thrown ball in the world (flying, rolling or lying on the ground). */
export interface BallSnapshot {
  id: string;
  owner: string;
  /** Owner's throw sequence number, so the thrower can match its predicted ball. */
  seq: number;
  ball: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Ball time already simulated (s). */
  t: number;
  resting: boolean;
}

export interface Vec3Msg {
  x: number;
  y: number;
  z: number;
}

export interface RemotePlayerMove {
  id: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  anim: AnimState;
  mount?: string;
  follower?: string;
  inBattle: boolean;
}

export interface CreatureMove {
  id: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  anim: CreatureAnim;
}

export type DialogChoice =
  | { kind: "starter"; options: string[] }
  | { kind: "shop"; items: { id: string; price: number }[] };

export type WorldEvent =
  | { kind: "clock"; clock: WorldClock }
  | { kind: "message"; text: string }
  | { kind: "legendary"; text: string };

export type ServerMessage =
  | {
      type: "WELCOME";
      playerId: string;
      token: string;
      protocol: number;
      region: string;
      self: PlayerSnapshot;
      state: PlayerPrivateState;
      clock: WorldClock;
      multiplayer: boolean;
    }
  | { type: "ERROR"; code: string; message: string }
  | { type: "PLAYER_STATE"; state: PlayerPrivateState }
  | { type: "PLAYER_JOIN"; player: PlayerSnapshot }
  | { type: "PLAYER_LEAVE"; id: string }
  | { type: "PLAYER_MOVE"; players: RemotePlayerMove[] }
  | { type: "PLAYER_CORRECT"; zone: string; x: number; y: number; z: number; rotY?: number; reason: string }
  | { type: "POKEMON_SPAWN"; creatures: WildSnapshot[] }
  | { type: "POKEMON_DESPAWN"; ids: string[]; reason?: "captured" | "fled" | "despawn" | "defeated" }
  | { type: "POKEMON_MOVE"; creatures: CreatureMove[] }
  | { type: "BATTLE_START"; battle: BattleView }
  | { type: "BATTLE_RESULT"; battle: BattleView; events: BattleEvent[]; outcome?: BattleOutcome }
  | { type: "BALL_SPAWN"; ball: BallSnapshot }
  | { type: "BALL_UPDATE"; id: string; kind: "rest" | "pickup" | "remove" | "deflect"; x: number; y: number; z: number; vx?: number; vy?: number; vz?: number; text?: string }
  | {
      /** Played by every client that sees it: hit, absorb, drop, shakes, result. */
      type: "CAPTURE_SEQUENCE";
      ballId: string;
      ball: string;
      targetId: string;
      species: string;
      hit: Vec3Msg;
      rest: Vec3Msg;
      critical: boolean;
      shakes: number;
      success: boolean;
      /** Seconds until the server applies the result. */
      duration: number;
    }
  | {
      /** Sent to the thrower when the sequence ends. */
      type: "CAPTURE_RESULT";
      ballId: string;
      targetId: string;
      success: boolean;
      creature?: CreatureInstance;
      sentTo?: "party" | "box";
      newSpecies?: boolean;
      reaction?: "flee" | "battle" | "watch";
    }
  | { type: "QUEST_UPDATE"; quests: QuestState; started: string[]; completed: string[] }
  | { type: "WORLD_EVENT"; event: WorldEvent }
  | { type: "DIALOG"; speaker: string; lines: string[]; choice?: DialogChoice }
  | { type: "TOAST"; text: string; tone?: "info" | "good" | "bad" }
  | { type: "PONG"; t: number; serverTime: number };

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Rejects malformed input before it reaches the simulation. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const str = (v: unknown, max = 64) => typeof v === "string" && v.length <= max;

  switch (m.type) {
    case "HELLO":
      return num(m.protocol) && str(m.name, 24) && (m.playerId === undefined || str(m.playerId)) && (m.token === undefined || str(m.token, 128))
        ? (m as ClientMessage)
        : null;
    case "PLAYER_MOVE":
      return num(m.seq) && num(m.x) && num(m.y) && num(m.z) && num(m.rotY) && str(m.anim, 8) ? (m as ClientMessage) : null;
    case "PLAYER_ROTATE":
      return num(m.rotY) ? (m as ClientMessage) : null;
    case "PLAYER_ACTION":
      return typeof m.action === "object" && m.action !== null && str((m.action as Record<string, unknown>).kind, 24)
        ? (m as ClientMessage)
        : null;
    case "BATTLE_ACTION":
      return str(m.battleId) && typeof m.action === "object" && m.action !== null ? (m as ClientMessage) : null;
    case "BALL_THROW":
      return num(m.seq) && str(m.ball) && num(m.x) && num(m.y) && num(m.z) && num(m.vx) && num(m.vy) && num(m.vz) ? (m as ClientMessage) : null;
    case "PING":
      return num(m.t) ? (m as ClientMessage) : null;
    default:
      return null;
  }
}
