/**
 * Content-pack schema. Everything named or drawn in the game (creatures, moves,
 * items, regions, quests, legendary events) is data in content/, never code.
 */

export type StatKey = "hp" | "atk" | "def" | "spa" | "spd" | "spe";
export type Stats = Record<StatKey, number>;
export const STAT_KEYS: readonly StatKey[] = ["hp", "atk", "def", "spa", "spd", "spe"];

export type TimePeriod = "dawn" | "day" | "afternoon" | "dusk" | "night";
export type Weather = "clear" | "rain" | "fog";
export type Layer = "land" | "water_surface" | "underwater" | "air";
export type MovementMode = "walk" | "swim" | "dive" | "fly";
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

export type StatusCondition = "sleep" | "freeze" | "paralysis" | "poison" | "burn";

export type MoveEffect =
  | { kind: "stat"; target: "self" | "foe"; stat: Exclude<StatKey, "hp">; stages: number; chance?: number }
  | { kind: "heal"; fraction: number }
  | { kind: "drain"; fraction: number }
  | { kind: "status"; status: StatusCondition; chance?: number }
  | { kind: "rest" }
  | { kind: "none" };

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

/**
 * A Pokémon species (content/pokemon/species/*.json). Visuals are referenced
 * by id only (modelId/textureId); the client's PokemonAssetRegistry resolves
 * them to user-provided model files, or reports MISSING_POKEMON_ASSET.
 */
export interface SpeciesDef {
  id: string;
  dexNumber: number;
  name: string;
  types: string[];
  baseStats: Stats;
  /** 3 (hard) .. 255 (easy). */
  catchRate: number;
  baseExp: number;
  /** Official height (m) and weight (kg). */
  height: number;
  weight: number;
  /** Multiplier applied to the model on top of its own units. */
  baseScale: number;
  /** Collision/capture box at scale 1 (blocks). */
  hitbox: { width: number; height: number };
  /** Fraction of females, or -1 for genderless. */
  genderRatio: number;
  abilities: string[];
  modelId: string;
  textureId: string;
  movement: { land: boolean; water: boolean; underwater: boolean; air: boolean };
  /** Animation names in the model's animation set, per pose. */
  animations: Partial<Record<PokemonAnimSlot, string>>;
  behavior: { temperament: "timid" | "neutral" | "aggressive"; speed: number };
  learnset: { level: number; move: string }[];
  evolution?: { to: string; level: number };
  mount?: { modes: MountMode[]; speed: number };
  legendary?: boolean;
  /** Capture restrictions: some Pokémon must be battled before a ball can work. */
  encounter?: { requiresBattle?: boolean; storyFlag?: string };
}

export type PokemonAnimSlot = "idle" | "walk" | "run" | "swim" | "fly" | "battleIdle" | "attack" | "recoil" | "faint" | "capture";

export interface BallLook {
  top: string;
  bottom: string;
  band: string;
  button: string;
  stripe?: string;
}

export interface ItemDef {
  id: string;
  name: string;
  nameKo?: string;
  kind: "capture" | "heal" | "key" | "material";
  price?: number;
  heal?: number;
  cureStatus?: boolean;
  /** Poké Ball colours (capture items). */
  ball?: BallLook;
  color: string;
  description: string;
}

/** A situational ball modifier (content/capture/balls.json). */
export type BallCondition =
  | { when: "firstTurn"; maxTurn: number; multiplier: number }
  | { when: "water"; multiplier: number }
  | { when: "dark"; maxLight: number; multiplier: number }
  | { when: "cave"; multiplier: number }
  | { when: "night"; multiplier: number }
  | { when: "targetType"; types: string[]; multiplier: number }
  | { when: "turnScaling"; perTurn: number; max: number }
  | { when: "previouslyCaught"; multiplier: number }
  | { when: "lowLevel"; maxLevel: number; multiplier: number };

export interface BallDef {
  baseMultiplier?: number;
  conditions?: BallCondition[];
}

/** Every capture coefficient (content/capture/capture.json). */
export interface CaptureConfigDef {
  id: string;
  maxShakes: number;
  shakeChecks: number;
  shakeExponent: number;
  status: Record<"none" | StatusCondition, number>;
  lowLevel: { belowLevel: number; base: number; perLevel: number; divisor: number };
  overLevel: { perLevel: number; min: number };
  alphaMultiplier: number;
  legendaryMultiplier: number;
  rareMultiplier: Partial<Record<"rare" | "very_rare", number>>;
  fieldThrow: { unawareBonus: number; battleBonus: number };
  environment: { underwaterPenalty: number };
  critical: { enabled: boolean; caughtSteps: [number, number][]; scale: number; dexSize: number };
  maxModifiedRate: number;
}

export interface Range {
  min: number;
  max: number;
}

export interface SpawnRuleDef {
  id: string;
  species: string;
  /** Region id; defaults to every region. */
  region?: string;
  biomes: string[];
  /** Finer terrain features: riverbank, waterfall, flower_field, meadow, clearing, cliff, reef, crater, summit. */
  subBiomes?: string[];
  layer?: Layer;
  time?: TimePeriod[];
  weather?: Weather[];
  altitude?: Range;
  waterDepth?: Range;
  level: Range;
  weight: number;
  rarity: "common" | "uncommon" | "rare" | "very_rare";
  /** Chance that a spawn from this rule is an Alpha (bigger, stronger, harder to catch). */
  alphaChance?: number;
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
  /** Wall height in blocks (roof sits on top). */
  h: number;
  roof: "red" | "blue" | "green" | "orange";
  door: "n" | "s" | "e" | "w";
}

export interface NpcDef {
  id: string;
  name: string;
  role: "professor" | "nurse" | "clerk" | "villager" | "trainer" | "elder";
  x: number;
  z: number;
  /** Feet height; defaults to the ground under x/z. */
  y?: number;
  facing: number;
  look: { skin: string; hair: string; shirt: string; pants: string };
  dialogue: string[];
  trainer?: string;
  shop?: string[];
}

export interface InteractableDef {
  id: string;
  kind: "tablet" | "altar" | "crystal" | "sign";
  name: string;
  x: number;
  z: number;
  /** Block height of the object's base; defaults to the ground under x/z. */
  y?: number;
  text?: string[];
  item?: { id: string; count: number };
}

export interface RuinDef {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  /** "temple" sits on land, "sunken" on the sea floor. */
  style?: "temple" | "sunken";
}

export interface AreaDef {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  /** Optional vertical band (cave areas under the surface). */
  minY?: number;
  maxY?: number;
}

/**
 * A river from source to mouth. Its water level is derived from the terrain
 * (never rising downstream); steep drops in the mountains become waterfalls.
 */
export interface RiverDef {
  id: string;
  points: [number, number][];
  width: number;
  depth: number;
  /** Caps the level (e.g. a river flowing out of a lake starts at the lake surface). */
  maxLevel?: number;
}

export interface LakeDef {
  x: number;
  z: number;
  rx: number;
  rz: number;
  depth: number;
  /** Water surface height. */
  level: number;
}

/** Mountain range along a ridge line; peaks reach `height`. */
export interface MountainRangeDef {
  points: [number, number][];
  width: number;
  height: number;
}

export interface VolcanoDef {
  x: number;
  z: number;
  radius: number;
  height: number;
  crater: number;
}

/** Underground chamber of a cave system. */
export interface CaveChamberDef {
  id: string;
  kind: "cavern" | "crystal" | "ruin" | "lake";
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

/**
 * A hand-placed cave system carved into the voxel world. `path` starts at the
 * entrance (y = null means "on the surface there"), and every point is [x, y, z].
 */
export interface CaveSystemDef {
  id: string;
  name: string;
  path: [number, number | null, number][];
  radius: number;
  chambers: CaveChamberDef[];
  /** Timbered mine tunnel. */
  mine?: [number, number, number][];
  /** Underground river: water runs along the floor of this tunnel. */
  river?: [number, number, number][];
}

export interface ShipwreckDef {
  id: string;
  x: number;
  z: number;
  /** 0: bow points +x, 1: bow points +z. */
  axis: 0 | 1;
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
  /** Map panel extent. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  town: { x: number; z: number; radius: number; height: number };
  roads: { points: [number, number][]; width: number }[];
  rivers: RiverDef[];
  lakes: LakeDef[];
  /** Sea lies south of `z` and east of `eastX` (both wobble with noise). */
  coast: { z: number; eastX: number; beachWidth: number; coldWestX: number };
  forests: { x: number; z: number; rx: number; rz: number }[];
  hills: { x: number; z: number; radius: number; height: number }[];
  mountains: MountainRangeDef[];
  volcanoes: VolcanoDef[];
  islands: { x: number; z: number; radius: number; height: number }[];
  snowline: number;
  buildings: BuildingDef[];
  ruins: RuinDef[];
  shipwrecks: ShipwreckDef[];
  caves: CaveSystemDef[];
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
