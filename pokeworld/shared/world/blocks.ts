/**
 * Voxel block registry. Every block is a 1x1x1 m cube with its own top, side
 * and bottom texture (atlas tiles painted by the client at startup). Ids are
 * stable: saved worlds, the server and the client all agree on them.
 */

/** Atlas tiles (index into the 16x16 tile terrain atlas). */
export const Tile = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  GRAVEL: 5,
  CLAY: 6,
  SNOW: 7,
  SNOW_SIDE: 8,
  ICE: 9,
  PACKED_ICE: 10,
  DEEPSLATE: 11,
  DEEPSLATE_TOP: 12,
  OAK_LOG: 13,
  OAK_LOG_TOP: 14,
  OAK_LEAVES: 15,
  BIRCH_LOG: 16,
  BIRCH_LOG_TOP: 17,
  BIRCH_LEAVES: 18,
  PINE_LOG: 19,
  PINE_LOG_TOP: 20,
  PINE_LEAVES: 21,
  JUNGLE_LOG: 22,
  JUNGLE_LOG_TOP: 23,
  JUNGLE_LEAVES: 24,
  WATER: 25,
  COAL_ORE: 26,
  COPPER_ORE: 27,
  IRON_ORE: 28,
  GOLD_ORE: 29,
  CRYSTAL: 30,
  ANCIENT_STONE: 31,
  ANCIENT_CARVED: 32,
  LAVA: 33,
  BASALT: 34,
  BASALT_TOP: 35,
  OBSIDIAN: 36,
  BEDROCK: 37,
  PATH_TOP: 38,
  PATH_SIDE: 39,
  PLANKS: 40,
  DARK_PLANKS: 41,
  COBBLE: 42,
  STONE_BRICKS: 43,
  MOSSY_BRICKS: 44,
  BRICK: 45,
  PLASTER: 46,
  GLASS: 47,
  ROOF: 48,
  CORAL: 49,
  SANDSTONE: 50,
  SANDSTONE_TOP: 51,
  PODZOL_TOP: 52,
  PODZOL_SIDE: 53,
  MUSHROOM_CAP: 54,
  MUSHROOM_STEM: 55,
  MOSS: 56,
  LAMP: 57,
  MAGMA: 58,
  ASH: 59,
  DOOR: 60,
  SNOWY_GRASS_SIDE: 61,
  DEEPSLATE_ORE: 62,
  BOOKSHELF: 63,
  // Flora (cross-quad sprites drawn by the instanced flora layer)
  FLORA_GRASS: 64,
  FLORA_FLOWER_RED: 65,
  FLORA_FLOWER_YELLOW: 66,
  FLORA_FLOWER_BLUE: 67,
  FLORA_MUSHROOM_RED: 68,
  FLORA_MUSHROOM_BROWN: 69,
  FLORA_SEAGRASS: 70,
  FLORA_KELP: 71,
  FLORA_FERN: 72,
  FLORA_DEAD_BUSH: 73,
  FLORA_REED: 74,
  FLORA_GLOW_SHROOM: 75,
} as const;

export const ATLAS_COLUMNS = 16;

export const Block = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  GRAVEL: 5,
  CLAY: 6,
  SNOW: 7,
  ICE: 8,
  DEEPSLATE: 9,
  OAK_LOG: 10,
  OAK_LEAVES: 11,
  BIRCH_LOG: 12,
  BIRCH_LEAVES: 13,
  PINE_LOG: 14,
  PINE_LEAVES: 15,
  JUNGLE_LOG: 16,
  JUNGLE_LEAVES: 17,
  WATER: 18,
  COAL_ORE: 19,
  COPPER_ORE: 20,
  IRON_ORE: 21,
  GOLD_ORE: 22,
  CRYSTAL: 23,
  ANCIENT_STONE: 24,
  LAVA: 25,
  BASALT: 26,
  OBSIDIAN: 27,
  PACKED_ICE: 28,
  BEDROCK: 29,
  PATH: 30,
  PLANKS: 31,
  COBBLE: 32,
  STONE_BRICKS: 33,
  MOSSY_BRICKS: 34,
  BRICK: 35,
  PLASTER: 36,
  GLASS: 37,
  ROOF_RED: 38,
  ROOF_BLUE: 39,
  ROOF_GREEN: 40,
  ROOF_ORANGE: 41,
  CORAL_RED: 42,
  CORAL_YELLOW: 43,
  CORAL_BLUE: 44,
  CORAL_PINK: 45,
  SANDSTONE: 46,
  PODZOL: 47,
  SNOWY_GRASS: 48,
  MUSHROOM_CAP: 49,
  MUSHROOM_STEM: 50,
  MOSS: 51,
  LAMP: 52,
  DARK_PLANKS: 53,
  MAGMA: 54,
  ASH: 55,
  ANCIENT_CARVED: 56,
  DOOR: 57,
  BOOKSHELF: 58,
  DEEPSLATE_GOLD: 59,
} as const;

export type BlockId = (typeof Block)[keyof typeof Block];

export interface BlockInfo {
  id: number;
  name: string;
  top: number;
  side: number;
  bottom: number;
  /** Has collision. */
  solid: boolean;
  /** Hides the faces of neighbours (and casts ambient occlusion). */
  opaque: boolean;
  liquid: boolean;
  /** Block light emitted, 0..15. */
  light: number;
  /** Multiplied with the atlas texel; null = biome tint (grass/leaves) or white. */
  tint: [number, number, number] | null;
  /** Uses the column's biome foliage colour on its top (and on all faces for leaves). */
  biomeTint: "top" | "all" | null;
}

export const BLOCKS: BlockInfo[] = [];

function def(
  id: number,
  name: string,
  top: number,
  side = top,
  bottom = top,
  opts: Partial<Pick<BlockInfo, "solid" | "opaque" | "liquid" | "light" | "tint" | "biomeTint">> = {},
): void {
  BLOCKS[id] = {
    id,
    name,
    top,
    side,
    bottom,
    solid: opts.solid ?? true,
    opaque: opts.opaque ?? true,
    liquid: opts.liquid ?? false,
    light: opts.light ?? 0,
    tint: opts.tint ?? null,
    biomeTint: opts.biomeTint ?? null,
  };
}

const T = Tile;
def(Block.AIR, "air", T.DIRT, T.DIRT, T.DIRT, { solid: false, opaque: false });
def(Block.GRASS, "grass", T.GRASS_TOP, T.GRASS_SIDE, T.DIRT, { biomeTint: "top" });
def(Block.DIRT, "dirt", T.DIRT);
def(Block.STONE, "stone", T.STONE);
def(Block.SAND, "sand", T.SAND);
def(Block.GRAVEL, "gravel", T.GRAVEL);
def(Block.CLAY, "clay", T.CLAY);
def(Block.SNOW, "snow", T.SNOW);
def(Block.ICE, "ice", T.ICE);
def(Block.DEEPSLATE, "deepslate", T.DEEPSLATE_TOP, T.DEEPSLATE, T.DEEPSLATE_TOP);
def(Block.OAK_LOG, "oak_log", T.OAK_LOG_TOP, T.OAK_LOG, T.OAK_LOG_TOP);
def(Block.OAK_LEAVES, "oak_leaves", T.OAK_LEAVES, T.OAK_LEAVES, T.OAK_LEAVES, { biomeTint: "all" });
def(Block.BIRCH_LOG, "birch_log", T.BIRCH_LOG_TOP, T.BIRCH_LOG, T.BIRCH_LOG_TOP);
def(Block.BIRCH_LEAVES, "birch_leaves", T.BIRCH_LEAVES, T.BIRCH_LEAVES, T.BIRCH_LEAVES, { tint: [0.62, 0.8, 0.42] });
def(Block.PINE_LOG, "pine_log", T.PINE_LOG_TOP, T.PINE_LOG, T.PINE_LOG_TOP);
def(Block.PINE_LEAVES, "pine_leaves", T.PINE_LEAVES, T.PINE_LEAVES, T.PINE_LEAVES, { tint: [0.38, 0.58, 0.42] });
def(Block.JUNGLE_LOG, "jungle_log", T.JUNGLE_LOG_TOP, T.JUNGLE_LOG, T.JUNGLE_LOG_TOP);
def(Block.JUNGLE_LEAVES, "jungle_leaves", T.JUNGLE_LEAVES, T.JUNGLE_LEAVES, T.JUNGLE_LEAVES, { biomeTint: "all" });
def(Block.WATER, "water", T.WATER, T.WATER, T.WATER, { solid: false, opaque: false, liquid: true });
def(Block.COAL_ORE, "coal_ore", T.COAL_ORE);
def(Block.COPPER_ORE, "copper_ore", T.COPPER_ORE);
def(Block.IRON_ORE, "iron_ore", T.IRON_ORE);
def(Block.GOLD_ORE, "gold_ore", T.GOLD_ORE);
def(Block.CRYSTAL, "crystal", T.CRYSTAL, T.CRYSTAL, T.CRYSTAL, { light: 11 });
def(Block.ANCIENT_STONE, "ancient_stone", T.ANCIENT_STONE);
def(Block.LAVA, "lava", T.LAVA, T.LAVA, T.LAVA, { solid: false, opaque: true, liquid: true, light: 15 });
def(Block.BASALT, "basalt", T.BASALT_TOP, T.BASALT, T.BASALT_TOP);
def(Block.OBSIDIAN, "obsidian", T.OBSIDIAN);
def(Block.PACKED_ICE, "packed_ice", T.PACKED_ICE);
def(Block.BEDROCK, "bedrock", T.BEDROCK);
def(Block.PATH, "path", T.PATH_TOP, T.PATH_SIDE, T.DIRT);
def(Block.PLANKS, "planks", T.PLANKS);
def(Block.COBBLE, "cobblestone", T.COBBLE);
def(Block.STONE_BRICKS, "stone_bricks", T.STONE_BRICKS);
def(Block.MOSSY_BRICKS, "mossy_stone_bricks", T.MOSSY_BRICKS);
def(Block.BRICK, "brick", T.BRICK);
def(Block.PLASTER, "plaster", T.PLASTER);
def(Block.GLASS, "glass", T.GLASS);
def(Block.ROOF_RED, "roof_red", T.ROOF, T.ROOF, T.PLANKS, { tint: [0.92, 0.36, 0.32] });
def(Block.ROOF_BLUE, "roof_blue", T.ROOF, T.ROOF, T.PLANKS, { tint: [0.38, 0.56, 0.95] });
def(Block.ROOF_GREEN, "roof_green", T.ROOF, T.ROOF, T.PLANKS, { tint: [0.42, 0.78, 0.45] });
def(Block.ROOF_ORANGE, "roof_orange", T.ROOF, T.ROOF, T.PLANKS, { tint: [0.98, 0.62, 0.3] });
def(Block.CORAL_RED, "coral_red", T.CORAL, T.CORAL, T.CORAL, { tint: [0.95, 0.35, 0.35] });
def(Block.CORAL_YELLOW, "coral_yellow", T.CORAL, T.CORAL, T.CORAL, { tint: [0.98, 0.85, 0.3] });
def(Block.CORAL_BLUE, "coral_blue", T.CORAL, T.CORAL, T.CORAL, { tint: [0.35, 0.55, 0.98] });
def(Block.CORAL_PINK, "coral_pink", T.CORAL, T.CORAL, T.CORAL, { tint: [0.98, 0.55, 0.8] });
def(Block.SANDSTONE, "sandstone", T.SANDSTONE_TOP, T.SANDSTONE, T.SANDSTONE_TOP);
def(Block.PODZOL, "podzol", T.PODZOL_TOP, T.PODZOL_SIDE, T.DIRT);
def(Block.SNOWY_GRASS, "snowy_grass", T.SNOW, T.SNOWY_GRASS_SIDE, T.DIRT);
def(Block.MUSHROOM_CAP, "mushroom_cap", T.MUSHROOM_CAP);
def(Block.MUSHROOM_STEM, "mushroom_stem", T.MUSHROOM_STEM);
def(Block.MOSS, "moss", T.MOSS);
def(Block.LAMP, "lamp", T.LAMP, T.LAMP, T.LAMP, { light: 14 });
def(Block.DARK_PLANKS, "dark_planks", T.DARK_PLANKS);
def(Block.MAGMA, "magma", T.MAGMA, T.MAGMA, T.MAGMA, { light: 9 });
def(Block.ASH, "ash", T.ASH);
def(Block.ANCIENT_CARVED, "ancient_carved", T.ANCIENT_STONE, T.ANCIENT_CARVED, T.ANCIENT_STONE, { light: 6 });
def(Block.DOOR, "door", T.DARK_PLANKS, T.DOOR, T.DARK_PLANKS);
def(Block.BOOKSHELF, "bookshelf", T.PLANKS, T.BOOKSHELF, T.PLANKS);
def(Block.DEEPSLATE_GOLD, "deepslate_gold_ore", T.DEEPSLATE_TOP, T.DEEPSLATE_ORE, T.DEEPSLATE_TOP);

export const BLOCK_COUNT = BLOCKS.length;

/** Lookup tables for the hot loops (mesher, physics, light). */
export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const LIGHT = new Uint8Array(256);
for (const b of BLOCKS) {
  if (!b) continue;
  SOLID[b.id] = b.solid ? 1 : 0;
  OPAQUE[b.id] = b.opaque ? 1 : 0;
  LIGHT[b.id] = b.light;
}

export const blockByName = (name: string): number => {
  const b = BLOCKS.find((x) => x && x.name === name);
  if (!b) throw new Error(`unknown block ${name}`);
  return b.id;
};

/**
 * Surface biomes and underground sub-biomes. Ids are stable: spawn rules,
 * quests and the map refer to biomes by name.
 */
export const BIOMES = [
  "plains",
  "forest_edge",
  "forest",
  "deep_forest",
  "hills",
  "mountain",
  "snow_mountain",
  "volcano",
  "river",
  "lake",
  "beach",
  "coast",
  "shallow_sea",
  "open_ocean",
  "deep_ocean",
  "abyss",
  "cold_ocean",
  "town",
  "ruins",
  "island",
  // Underground (decided per position, not per column)
  "cave",
  "cavern",
  "underground_river",
  "crystal_cave",
  "mine",
  "deep_cave",
  "ancient_ruin",
] as const;

export type BiomeName = (typeof BIOMES)[number];

export const BiomeId = Object.fromEntries(BIOMES.map((name, i) => [name, i])) as Record<BiomeName, number>;

export const UNDERGROUND_BIOMES: readonly BiomeName[] = ["cave", "cavern", "underground_river", "crystal_cave", "mine", "deep_cave", "ancient_ruin"];
export const WATER_BIOMES: readonly BiomeName[] = ["river", "lake", "coast", "shallow_sea", "open_ocean", "deep_ocean", "abyss", "cold_ocean"];

/** Map colours (client map panel). */
export const BIOME_COLORS: Record<BiomeName, string> = {
  plains: "#86c86a",
  forest_edge: "#5fa652",
  forest: "#2f7a3a",
  deep_forest: "#1f5a2c",
  hills: "#9cb56a",
  mountain: "#8d8d8d",
  snow_mountain: "#eef3f8",
  volcano: "#5a3a34",
  river: "#4aa3e0",
  lake: "#3d8fd8",
  beach: "#e8d9a0",
  coast: "#4aa0dc",
  shallow_sea: "#3a8ad0",
  open_ocean: "#2a62b0",
  deep_ocean: "#1b3f7a",
  abyss: "#0e2250",
  cold_ocean: "#2f5a90",
  town: "#d8c7a4",
  ruins: "#b59e7a",
  island: "#c9d98a",
  cave: "#4a4450",
  cavern: "#3e3848",
  underground_river: "#2a4a6a",
  crystal_cave: "#5a8ab0",
  mine: "#6a5a40",
  deep_cave: "#2a2630",
  ancient_ruin: "#8a7a5a",
};

/** Grass/leaf colour per surface biome (Minecraft-style foliage tint). */
export const FOLIAGE: Partial<Record<BiomeName, [number, number, number]>> = {
  plains: [0.56, 0.82, 0.38],
  forest_edge: [0.48, 0.76, 0.34],
  forest: [0.38, 0.66, 0.28],
  deep_forest: [0.3, 0.55, 0.24],
  hills: [0.52, 0.74, 0.36],
  mountain: [0.5, 0.66, 0.4],
  snow_mountain: [0.55, 0.7, 0.55],
  volcano: [0.55, 0.55, 0.3],
  river: [0.5, 0.78, 0.36],
  lake: [0.5, 0.78, 0.36],
  beach: [0.6, 0.8, 0.4],
  town: [0.56, 0.82, 0.38],
  ruins: [0.5, 0.7, 0.36],
  island: [0.5, 0.86, 0.36],
};
export const DEFAULT_FOLIAGE: [number, number, number] = [0.52, 0.78, 0.36];
