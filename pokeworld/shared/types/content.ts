/**
 * Content-pack schema. Everything named or drawn in the game (creatures, moves,
 * items, regions, quests, legendary events) is data in content/, never code.
 */

export type StatKey = "hp" | "atk" | "def" | "spa" | "spd" | "spe";
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: readonly StatKey[] = ["hp", "atk", "def", "spa", "spd", "spe"];

export type TimePeriod = "dawn" | "day" | "dusk" | "night";
export type Weather = "clear" | "rain" | "fog";
export type Layer = "land" | "water_surface" | "underwater" | "air";
export type MovementMode = "walk" | "swim" | "fly";
export type MountMode = "land" | "swim" | "fly";

export interface TypeDef {
  id: string;
  name: string;
  color: string;
}

export interface TypeChartDef {
  types: TypeDef[];
  /** attacking type -> defending type -> multiplier; missing pairs are 1. */
  effectiveness: Record<string, Record<string, number>>;
}

export type MoveEffect =
  | { kind: "stat"; target: "self" | "foe"; stat: Exclude<StatKey, "hp">; stages: number; chance?: number }
  | { kind: "heal"; fraction: number }
  | { kind: "drain"; fraction: number };

export interface MoveDef {
  id: string;
  name: string;
  type: string;
  category: "physical" | "special" | "status";
  power: number;
  accuracy: number;
  pp: number;
  priority?: number;
  effect?: MoveEffect;
  /** Visual hint for the client: "melee" lunges, "projectile" fires a bolt, "aura" glows. */
  fx?: "melee" | "projectile" | "aura";
}

export interface ModelColors {
  primary: string;
  secondary: string;
  accent: string;
  eye?: string;
}

export type PartRole =
  | "body"
  | "head"
  | "legFL"
  | "legFR"
  | "legBL"
  | "legBR"
  | "legL"
  | "legR"
  | "armL"
  | "armR"
  | "wingL"
  | "wingR"
  | "tail"
  | "fin"
  | "deco";

export interface PartDef {
  name: string;
  role: PartRole;
  /** Box size in model units (1 unit = 1 m at scale 1). */
  size: [number, number, number];
  /** Position of the part pivot relative to its parent pivot. */
  pos: [number, number, number];
  /** Offset of the box centre from its pivot (legs hang below the hip, wings extend sideways). */
  offset?: [number, number, number];
  color: "primary" | "secondary" | "accent" | "eye" | string;
  parent?: string;
}

export type Rig = "quadruped" | "biped" | "bird" | "fish" | "blob" | "bat";

export interface ModelTemplateDef {
  id: string;
  rig: Rig;
  parts: PartDef[];
}

export interface AnimationProfileDef {
  rig: Rig;
  idle: { bob: number; speed: number };
  walk: { freq: number; swing: number; bob: number };
  run: { freq: number; swing: number; bob: number };
  swim: { freq: number; sway: number; bob: number };
  fly: { flapFreq: number; flapAngle: number; bob: number };
  battleIdle: { bob: number; speed: number };
  attack: { lunge: number; duration: number };
  faint: { duration: number };
}

export interface SpeciesDef {
  id: string;
  name: string;
  types: string[];
  baseStats: Stats;
  /** 3 (hard) .. 255 (easy). */
  catchRate: number;
  baseExp: number;
  learnset: { level: number; move: string }[];
  evolution?: { to: string; level: number };
  model: { template: string; colors: ModelColors; scale?: number };
  behavior: {
    movement: MovementMode[];
    temperament: "timid" | "neutral" | "aggressive";
    speed: number;
  };
  mount?: { modes: MountMode[]; speed: number };
  legendary?: boolean;
  description: string;
}

export interface ItemDef {
  id: string;
  name: string;
  kind: "capture" | "heal" | "key" | "material";
  price?: number;
  captureBonus?: number;
  heal?: number;
  color: string;
  description: string;
}

export interface Range {
  min: number;
  max: number;
}

export interface SpawnRuleDef {
  id: string;
  species: string;
  /** "overworld" or "cave:<id>". Defaults to overworld. */
  zone?: string;
  biomes: string[];
  layer?: Layer;
  time?: TimePeriod[];
  weather?: Weather[];
  altitude?: Range;
  waterDepth?: Range;
  level: Range;
  weight: number;
  rarity: "common" | "uncommon" | "rare" | "very_rare";
  /** Quest that must be completed before this spawn appears. */
  quest?: string;
  /** Only within this many metres of a named ruin/structure. */
  structure?: { id: string; radius: number };
  progression?: { minCaught?: number };
}

export interface TrainerDef {
  id: string;
  name: string;
  title: string;
  team: { species: string; level: number }[];
  reward: number;
  dialogue: { before: string; win: string; lose: string; after: string };
}

export interface BuildingDef {
  id: string;
  kind: "center" | "shop" | "lab" | "house";
  name: string;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  roof: "red" | "blue" | "green" | "orange";
  door: "n" | "s" | "e" | "w";
}

export interface NpcDef {
  id: string;
  name: string;
  role: "professor" | "nurse" | "clerk" | "villager" | "trainer" | "elder";
  zone?: string;
  x: number;
  z: number;
  facing: number;
  look: { skin: string; hair: string; shirt: string; pants: string };
  dialogue: string[];
  trainer?: string;
  shop?: string[];
}

export interface InteractableDef {
  id: string;
  kind: "tablet" | "altar" | "crystal" | "cave_entrance" | "cave_exit" | "sign";
  name: string;
  zone?: string;
  x: number;
  z: number;
  text?: string[];
  cave?: string;
  item?: { id: string; count: number };
}

export interface CaveDef {
  id: string;
  name: string;
  /** Overworld point the entrance faces; also where the player returns. */
  entrance: { x: number; z: number };
  size: number;
  seed: number;
  /** Interior spawn point (cave-local coordinates). */
  start: { x: number; z: number };
  /** Main tunnel, guarantees the back chamber is reachable. */
  tunnel: [number, number][];
}

export interface RuinDef {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
}

export interface AreaDef {
  id: string;
  name: string;
  zone?: string;
  x: number;
  z: number;
  radius: number;
}

export interface RegionDef {
  id: string;
  name: string;
  seed: number;
  spawn: { x: number; z: number };
  respawn: { x: number; z: number };
  /** Species the professor offers as a first partner. */
  starters: string[];
  startingMoney: number;
  town: { x: number; z: number; radius: number; height: number };
  roads: { points: [number, number][]; width: number }[];
  river: { points: [number, number][]; width: number };
  lakes: { x: number; z: number; rx: number; rz: number; depth: number }[];
  coast: { z: number; beachWidth: number; deepZ: number; eastX: number };
  forests: { x: number; z: number; rx: number; rz: number }[];
  hills: { x: number; z: number; radius: number; height: number }[];
  mountains: { northZ: number; westX: number };
  islands: { x: number; z: number; radius: number }[];
  buildings: BuildingDef[];
  ruins: RuinDef[];
  caves: CaveDef[];
  npcs: NpcDef[];
  interactables: InteractableDef[];
  areas: AreaDef[];
}

export type QuestObjective =
  | { id: string; kind: "talk"; npc: string; text: string }
  | { id: string; kind: "obtain_partner"; text: string }
  | { id: string; kind: "catch"; count: number; species?: string; text: string }
  | { id: string; kind: "defeat_trainer"; trainer: string; text: string }
  | { id: string; kind: "win_battles"; count: number; text: string }
  | { id: string; kind: "visit"; area: string; text: string }
  | { id: string; kind: "collect"; item: string; count: number; text: string };

export interface QuestDef {
  id: string;
  title: string;
  description: string;
  type: "main" | "side" | "exploration" | "legendary";
  /** Quests that must be complete before this one starts automatically. */
  requires: string[];
  objectives: QuestObjective[];
  rewards: { money?: number; items?: { id: string; count: number }[] };
}

export type LegendaryNode =
  | { id: string; kind: "rumor"; npc: string; text: string; next: string[] }
  | { id: string; kind: "visit"; area: string; text: string; next: string[] }
  | { id: string; kind: "interact"; target: string; text: string; next: string[] }
  | { id: string; kind: "collect"; item: string; count: number; text: string; next: string[] }
  | {
      id: string;
      kind: "condition";
      target: string;
      time?: TimePeriod[];
      weather?: Weather[];
      consumeItem?: { id: string; count: number };
      text: string;
      next: string[];
    }
  | { id: string; kind: "guardian"; target: string; species: string; level: number; text: string; next: string[] }
  | { id: string; kind: "encounter"; target: string; species: string; level: number; text: string; next: string[] };

export interface LegendaryEventDef {
  id: string;
  name: string;
  start: string;
  nodes: LegendaryNode[];
}
