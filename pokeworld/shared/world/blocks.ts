/** Atlas tiles (index into the 8x8 terrain atlas the client paints at startup). */
export const Tile = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  SAND: 3,
  STONE: 4,
  GRAVEL: 5,
  SNOW: 6,
  SNOW_SIDE: 7,
  LOG_SIDE: 8,
  LOG_TOP: 9,
  PLANK: 10,
  ROOF: 11,
  PATH: 12,
  BRICK: 13,
  MOSSY: 14,
  CAVE_STONE: 15,
  CRYSTAL: 16,
  CLAY: 17,
  WALL: 18,
  LEAVES: 19,
  WATER: 20,
  FOREST_TOP: 21,
  FOREST_SIDE: 22,
  WINDOW_WALL: 23,
} as const;

export const ATLAS_COLUMNS = 8;

export const Block = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  SAND: 3,
  STONE: 4,
  GRAVEL: 5,
  SNOW: 6,
  LOG: 7,
  PLANK: 8,
  ROOF_RED: 9,
  ROOF_BLUE: 10,
  ROOF_GREEN: 11,
  ROOF_ORANGE: 12,
  PATH: 13,
  BRICK: 14,
  MOSSY: 15,
  CAVE_STONE: 16,
  CRYSTAL: 17,
  CLAY: 18,
  FOREST_GRASS: 19,
  WALL: 20,
} as const;

export interface BlockInfo {
  name: string;
  top: number;
  /** Side tile for the top metre of a column. */
  sideTop: number;
  /** Side tile below the top metre. */
  side: number;
  /** Vertex tint multiplied with the atlas texel. */
  tint: [number, number, number];
}

const info = (name: string, top: number, sideTop: number, side: number, tint: [number, number, number] = [1, 1, 1]): BlockInfo => ({
  name,
  top,
  sideTop,
  side,
  tint,
});

export const BLOCKS: BlockInfo[] = [];
BLOCKS[Block.AIR] = info("air", Tile.DIRT, Tile.DIRT, Tile.DIRT);
BLOCKS[Block.GRASS] = info("grass", Tile.GRASS_TOP, Tile.GRASS_SIDE, Tile.DIRT);
BLOCKS[Block.DIRT] = info("dirt", Tile.DIRT, Tile.DIRT, Tile.DIRT);
BLOCKS[Block.SAND] = info("sand", Tile.SAND, Tile.SAND, Tile.SAND);
BLOCKS[Block.STONE] = info("stone", Tile.STONE, Tile.STONE, Tile.STONE);
BLOCKS[Block.GRAVEL] = info("gravel", Tile.GRAVEL, Tile.GRAVEL, Tile.STONE);
BLOCKS[Block.SNOW] = info("snow", Tile.SNOW, Tile.SNOW_SIDE, Tile.STONE);
BLOCKS[Block.LOG] = info("log", Tile.LOG_TOP, Tile.LOG_SIDE, Tile.LOG_SIDE);
BLOCKS[Block.PLANK] = info("plank", Tile.PLANK, Tile.PLANK, Tile.PLANK);
BLOCKS[Block.ROOF_RED] = info("roof_red", Tile.ROOF, Tile.WINDOW_WALL, Tile.WALL, [0.92, 0.36, 0.32]);
BLOCKS[Block.ROOF_BLUE] = info("roof_blue", Tile.ROOF, Tile.WINDOW_WALL, Tile.WALL, [0.36, 0.55, 0.95]);
BLOCKS[Block.ROOF_GREEN] = info("roof_green", Tile.ROOF, Tile.WINDOW_WALL, Tile.WALL, [0.42, 0.78, 0.45]);
BLOCKS[Block.ROOF_ORANGE] = info("roof_orange", Tile.ROOF, Tile.WINDOW_WALL, Tile.WALL, [0.98, 0.62, 0.3]);
BLOCKS[Block.PATH] = info("path", Tile.PATH, Tile.DIRT, Tile.DIRT);
BLOCKS[Block.BRICK] = info("brick", Tile.BRICK, Tile.BRICK, Tile.BRICK);
BLOCKS[Block.MOSSY] = info("mossy", Tile.MOSSY, Tile.MOSSY, Tile.BRICK);
BLOCKS[Block.CAVE_STONE] = info("cave_stone", Tile.CAVE_STONE, Tile.CAVE_STONE, Tile.CAVE_STONE);
BLOCKS[Block.CRYSTAL] = info("crystal", Tile.CRYSTAL, Tile.CRYSTAL, Tile.CAVE_STONE);
BLOCKS[Block.CLAY] = info("clay", Tile.CLAY, Tile.CLAY, Tile.DIRT);
BLOCKS[Block.FOREST_GRASS] = info("forest_grass", Tile.FOREST_TOP, Tile.FOREST_SIDE, Tile.DIRT);
BLOCKS[Block.WALL] = info("wall", Tile.WALL, Tile.WALL, Tile.WALL);

/** Ids are stable: spawn rules and quests refer to biomes by name. */
export const BIOMES = [
  "deep_ocean",
  "ocean",
  "coast",
  "beach",
  "grassland",
  "forest",
  "forest_edge",
  "river",
  "lake",
  "town",
  "hills",
  "mountain",
  "ruins",
  "cave",
  "island",
  "wetland",
] as const;

export type BiomeName = (typeof BIOMES)[number];

export const BiomeId = Object.fromEntries(BIOMES.map((name, i) => [name, i])) as Record<BiomeName, number>;

/** Map colours (also used by the client's map panel). */
export const BIOME_COLORS: Record<BiomeName, string> = {
  deep_ocean: "#1b3f7a",
  ocean: "#2a62b0",
  coast: "#3f8fd2",
  beach: "#e8d9a0",
  grassland: "#7fc36a",
  forest: "#2f7a3a",
  forest_edge: "#5aa152",
  river: "#4aa3e0",
  lake: "#3d8fd8",
  town: "#d8c7a4",
  hills: "#9cae6a",
  mountain: "#8d8d8d",
  ruins: "#b59e7a",
  cave: "#4a4450",
  island: "#c9d98a",
  wetland: "#6d9c6a",
};
