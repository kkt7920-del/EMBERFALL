import { CHUNK_SIZE, WORLD_HEIGHT } from "../config/constants";
import { BIOMES, Block, type BiomeName, LIGHT, SOLID } from "./blocks";
import type { TerrainGenerator } from "./generator";

const CS = CHUNK_SIZE;
const LAYER = CS * CS;

/** One 32 x 32 column chunk, trimmed to its highest non-air block. */
export interface ChunkVoxels {
  cx: number;
  cz: number;
  /** index = (y * 32 + lz) * 32 + lx, for 0 <= y <= top */
  blocks: Uint8Array;
  top: number;
  biomes: Uint8Array;
  /** Smooth-surface height per column (before caves/overhangs). */
  surface: Int16Array;
  /** Highest liquid block per column, -1 if none. */
  water: Int16Array;
}

export const chunkKey = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export interface RayHit {
  x: number;
  y: number;
  z: number;
  /** Face normal of the block that was hit. */
  nx: number;
  ny: number;
  nz: number;
  dist: number;
  block: number;
}

/**
 * Block storage shared by physics, AI, spawning and the capture projectile.
 * Chunks come from a meshing worker (client) or are generated on demand
 * (server, and the client's fallback) with the same deterministic generator,
 * so client prediction and server validation see identical blocks.
 */
export class VoxelWorld {
  private readonly chunks = new Map<number, ChunkVoxels>();
  /** Chunks the client keeps around the player; never evicted. */
  private readonly pinned = new Set<number>();
  generated = 0;

  constructor(
    readonly gen: TerrainGenerator,
    private readonly maxChunks = 196,
  ) {}

  get size(): number {
    return this.chunks.size;
  }

  has(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  put(c: ChunkVoxels): void {
    const k = chunkKey(c.cx, c.cz);
    this.chunks.delete(k);
    this.chunks.set(k, c);
    this.evict();
  }

  pin(keys: Set<number>): void {
    this.pinned.clear();
    for (const k of keys) this.pinned.add(k);
  }

  private evict(): void {
    if (this.chunks.size <= this.maxChunks) return;
    for (const k of this.chunks.keys()) {
      if (this.chunks.size <= this.maxChunks) break;
      if (!this.pinned.has(k)) this.chunks.delete(k);
    }
  }

  /** Returns the chunk, generating it synchronously if missing. */
  chunk(cx: number, cz: number): ChunkVoxels {
    const k = chunkKey(cx, cz);
    const c = this.chunks.get(k);
    if (c) return c;
    const box = this.gen.generateBox(cx * CS, cz * CS, CS, CS);
    const data = box.extract(cx * CS, cz * CS, CS, CS);
    const made: ChunkVoxels = { cx, cz, ...data };
    this.generated++;
    this.put(made);
    return made;
  }

  peekChunk(cx: number, cz: number): ChunkVoxels | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  block(x: number, y: number, z: number): number {
    if (y < 0) return Block.BEDROCK;
    if (y >= WORLD_HEIGHT) return Block.AIR;
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const iy = Math.floor(y);
    const cx = Math.floor(ix / CS);
    const cz = Math.floor(iz / CS);
    const c = this.chunk(cx, cz);
    if (iy > c.top) return Block.AIR;
    return c.blocks[iy * LAYER + (iz - cz * CS) * CS + (ix - cx * CS)];
  }

  solid(x: number, y: number, z: number): boolean {
    return SOLID[this.block(x, y, z)] === 1;
  }

  isWater(x: number, y: number, z: number): boolean {
    return this.block(x, y, z) === Block.WATER;
  }

  isLiquid(x: number, y: number, z: number): boolean {
    const b = this.block(x, y, z);
    return b === Block.WATER || b === Block.LAVA;
  }

  private column(x: number, z: number): { c: ChunkVoxels; i: number } {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const cx = Math.floor(ix / CS);
    const cz = Math.floor(iz / CS);
    return { c: this.chunk(cx, cz), i: (iz - cz * CS) * CS + (ix - cx * CS) };
  }

  surfaceBiome(x: number, z: number): BiomeName {
    const { c, i } = this.column(x, z);
    return BIOMES[c.biomes[i]];
  }

  surfaceHeight(x: number, z: number): number {
    const { c, i } = this.column(x, z);
    return c.surface[i];
  }

  /** Highest liquid block in the column (-1 if none). */
  waterTop(x: number, z: number): number {
    const { c, i } = this.column(x, z);
    return c.water[i];
  }

  /** Biome at a 3D position: underground sub-biomes below the surface, else the column biome. */
  biomeAt(x: number, y: number, z: number): BiomeName {
    const surface = this.surfaceHeight(x, z);
    if (y < surface - 3 && !this.skyVisible(x, y + 1, z)) {
      const under = this.gen.undergroundBiome(Math.floor(x), Math.floor(y), Math.floor(z), surface);
      if (under) return under;
    }
    return this.surfaceBiome(x, z);
  }

  /** True when no opaque block lies above (x, y, z). */
  skyVisible(x: number, y: number, z: number): boolean {
    const { c, i } = this.column(x, z);
    for (let yy = Math.max(0, Math.floor(y)); yy <= c.top; yy++) {
      const b = c.blocks[yy * LAYER + i];
      if (b !== Block.AIR && b !== Block.WATER) return false;
    }
    return true;
  }

  /** Highest solid block in the column, or -1. */
  topSolid(x: number, z: number): number {
    const { c, i } = this.column(x, z);
    for (let y = c.top; y >= 0; y--) if (SOLID[c.blocks[y * LAYER + i]]) return y;
    return -1;
  }

  /**
   * Feet height of the floor at or below `y` with `clearance` free blocks
   * above it, searching down at most `maxDrop` and up at most `maxRise`.
   * Returns null when there is no such floor (wall, chasm, deep water).
   */
  floorNear(x: number, y: number, z: number, clearance = 2, maxRise = 1, maxDrop = 6): number | null {
    const { c, i } = this.column(x, z);
    const iy = Math.floor(y + 0.01);
    const at = (yy: number) => (yy < 0 ? Block.BEDROCK : yy > c.top ? Block.AIR : c.blocks[yy * LAYER + i]);
    for (let feet = iy + maxRise; feet >= iy - maxDrop; feet--) {
      if (feet <= 0) break;
      if (!SOLID[at(feet - 1)]) continue;
      let free = true;
      for (let k = 0; k < clearance; k++) if (SOLID[at(feet + k)]) free = false;
      if (free) return feet;
    }
    return null;
  }

  /** Top of the water body containing (x, y, z), or null if not in water. */
  waterSurfaceAt(x: number, y: number, z: number): number | null {
    let yy = Math.floor(y);
    if (this.block(x, yy, z) !== Block.WATER) return null;
    while (yy < WORLD_HEIGHT - 1 && this.block(x, yy + 1, z) === Block.WATER) yy++;
    return yy + 1;
  }

  /** Block light at a position (for spawning in dark places); 0..15. */
  blockLightNear(x: number, y: number, z: number, radius = 4): number {
    let best = 0;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          const l = LIGHT[this.block(x + dx, y + dy, z + dz)];
          if (l) best = Math.max(best, l - Math.abs(dx) - Math.abs(dy) - Math.abs(dz));
        }
    return best;
  }

  /** Voxel DDA raycast against solid blocks (or liquids too). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, hitLiquid = false): RayHit | null {
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let t = 0;
    for (let i = 0; i < 512 && t <= maxDist; i++) {
      const b = this.block(x, y, z);
      if (SOLID[b] || (hitLiquid && (b === Block.WATER || b === Block.LAVA))) return { x, y, z, nx, ny, nz, dist: t, block: b };
      if (tmx < tmy && tmx < tmz) {
        x += sx;
        t = tmx;
        tmx += tdx;
        nx = -sx;
        ny = 0;
        nz = 0;
      } else if (tmy < tmz) {
        y += sy;
        t = tmy;
        tmy += tdy;
        nx = 0;
        ny = -sy;
        nz = 0;
      } else {
        z += sz;
        t = tmz;
        tmz += tdz;
        nx = 0;
        ny = 0;
        nz = -sz;
      }
    }
    return null;
  }
}
