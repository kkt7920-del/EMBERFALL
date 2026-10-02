import type { StatusCondition, Stats, TimePeriod, Weather } from "./content";

export interface MoveSlot {
  id: string;
  pp: number;
}

export type Gender = "male" | "female" | "genderless";

/** A Pokémon owned by a player or present in the wild. Stats derive from species + level + ivs + nature. */
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
  gender: Gender;
  nature: string;
  ability: string;
  /** Individual size multiplier (about 0.95..1.05; Alphas are much larger). */
  size: number;
  alpha?: boolean;
  status?: StatusCondition;
  /** Sleep turns left. */
  statusTurns?: number;
  /** Ball it was caught in. */
  ball?: string;
  caughtAt?: number;
  /** Where it was met (area name or biome). */
  origin?: string;
  metLevel?: number;
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
  /** PC storage (Pokémon caught while the party is full). */
  box: CreatureInstance[];
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

export type AnimState = "idle" | "walk" | "run" | "swim" | "dive" | "fly" | "jump";

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

export type CreatureAnim = "idle" | "walk" | "run" | "swim" | "fly" | "battle" | "attack" | "faint" | "sleep" | "recoil";

/** How a wild Pokémon is currently moving. */
export type WildMode = "walk" | "swim" | "dive" | "fly";

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
  mode: WildMode;
  size: number;
  alpha: boolean;
  gender: Gender;
  hp: number;
  maxHp: number;
  status?: StatusCondition;
  /** Story Pokémon (ruin guardian, legendary). */
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
