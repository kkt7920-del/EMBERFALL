/** World and simulation constants shared by client, local server and Node server. */

/** Horizontal chunk size in blocks (1 block = 1 m). Chunks span the full world height. */
export const CHUNK_SIZE = 32;

/** Ocean surface height (top of the highest sea water block is SEA_LEVEL - 1, surface at SEA_LEVEL). */
export const SEA_LEVEL = 62;

/** Blocks exist for 0 <= y < WORLD_HEIGHT. */
export const WORLD_HEIGHT = 256;

/** Server simulation ticks per second. */
export const TICK_RATE = 20;

/** Entities within this distance of a player are replicated to them. */
export const INTEREST_RADIUS = 96;

/** Wild creatures are spawned between these distances from a player. */
export const SPAWN_MIN_DISTANCE = 14;
export const SPAWN_MAX_DISTANCE = 46;

/** Wild creatures with no player within this distance are despawned. */
export const DESPAWN_DISTANCE = 80;

/** Spawn budget units around one player (large Pokémon use more than one), and server-wide count. */
export const SPAWN_BUDGET_PER_PLAYER = 14;
export const SPAWN_BUDGET_GLOBAL = 220;

export const MAX_PARTY = 6;

export const PROTOCOL_VERSION = 2;

/** Version of the player save format; see shared/types/save.ts migrations. */
export const SAVE_VERSION = 2;

/** Real seconds per in-game day. */
export const DAY_LENGTH_SECONDS = 20 * 60;

/** Interaction ranges (metres). */
export const INTERACT_RANGE = 3.5;
export const BATTLE_START_RANGE = 5;
/** Name/level shown on the aim reticle within this distance. */
export const CAPTURE_THROW_RANGE = 28;

/** Player movement limits used by the client controller and server validation. */
export const MOVE = {
  walk: 4.6,
  run: 7.4,
  swim: 3.2,
  fly: 13,
  gravity: 26,
  jumpVelocity: 8.6,
  stepHeight: 1.05,
  radius: 0.32,
  height: 1.75,
} as const;
