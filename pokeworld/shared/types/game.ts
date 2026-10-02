import type { Stats, TimePeriod, Weather } from "./content";

export interface MoveSlot {
  id: string;
  pp: number;
}

/** A creature owned by a player or present in the wild. Stats derive from species + level + ivs. */
export interface CreatureInstance {
  uid: string;
  species: string;
  nickname?: string;
  level: number;
  /** Total experience points. */
  exp: number;
  hp: number;
  ivs: Stats;
  moves: MoveSlot[];
  caughtAt?: number;
}

export type QuestProgress = Record<string, number>;

export interface QuestState {
  active: Record<string, QuestProgress>;
  completed: string[];
}

export interface LegendaryState {
  /** event id -> completed node ids */
  nodes: Record<string, string[]>;
  completed: string[];
}

export interface PlayerFlags {
  starterChosen: boolean;
  trainersDefeated: string[];
  collected: string[];
  visited: string[];
}

/** Private state only the owning player receives. */
export interface PlayerPrivateState {
  party: CreatureInstance[];
  boxCount: number;
  inventory: Record<string, number>;
  money: number;
  flags: PlayerFlags;
  quests: QuestState;
  legendary: LegendaryState;
  seen: string[];
  caught: string[];
  mounted: boolean;
}

export type AnimState = "idle" | "walk" | "run" | "swim" | "fly" | "jump";

export interface PlayerSnapshot {
  id: string;
  name: string;
  zone: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  anim: AnimState;
  /** Species currently ridden, if any. */
  mount?: string;
  /** Species of the lead creature following the player, if any. */
  follower?: string;
  inBattle: boolean;
}

export type CreatureAnim = "idle" | "walk" | "run" | "swim" | "fly" | "battle" | "attack" | "faint" | "sleep";

export interface WildSnapshot {
  id: string;
  species: string;
  level: number;
  zone: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  anim: CreatureAnim;
  /** Shiny-style colour variant or a quest-only creature. */
  special?: "guardian" | "legendary";
}

export interface WorldClock {
  /** In-game seconds since world start. */
  time: number;
  period: TimePeriod;
  /** 0..24 */
  hour: number;
  weather: Weather;
}
