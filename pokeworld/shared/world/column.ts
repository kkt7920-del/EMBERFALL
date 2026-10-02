import { WORLD_HEIGHT } from "../config/constants";
import { Block } from "./blocks";

/** Column flags. */
export const COL_ROAD = 1;
export const COL_TOWN = 2;
/** No trees or boulders (structures, plazas, riverbanks). */
export const COL_CLEAR = 4;
export const COL_RIVERBANK = 8;
export const COL_BRIDGE = 16;
export const COL_CLIFF = 32;
export const COL_WATERFALL = 64;

/**
 * Everything the 2D layer decides about one (x, z) column before the 3D pass
 * (overhangs, caves, ores, trees, structures).
 */
export interface ColumnInfo {
  /** Height of the topmost solid block of the smooth surface. */
  h: number;
  /** Highest liquid block (water fills h+1 .. water), or -1. */
  water: number;
  /** Block used for the liquid (water, lava). */
  liquid: number;
  biome: number;
  top: number;
  filler: number;
  fillerDepth: number;
  /** Amplitude of the 3D surface density (cliffs, overhangs) in blocks. */
  overhang: number;
  /** 0: caves stay deep below; 1: caves may break through the surface. */
  caveAllow: number;
  /** Tree density 0..1. */
  forest: number;
  mountain: number;
  flags: number;
}

export const newColumnInfo = (): ColumnInfo => ({
  h: 0,
  water: -1,
  liquid: Block.WATER,
  biome: 0,
  top: Block.GRASS,
  filler: Block.DIRT,
  fillerDepth: 3,
  overhang: 0,
  caveAllow: 0,
  forest: 0,
  mountain: 0,
  flags: 0,
});

/**
 * A box of full-height columns. Layout: index = (y * sz + lz) * sx + lx, so a
 * horizontal layer is contiguous (fast to trim at the top).
 */
export class VoxelBox {
  readonly blocks: Uint8Array;
  readonly biomes: Uint8Array;
  readonly surface: Int16Array;
  readonly waterTop: Int16Array;
  maxY = 0;

  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly sx: number,
    readonly sz: number,
  ) {
    this.blocks = new Uint8Array(sx * sz * WORLD_HEIGHT);
    this.biomes = new Uint8Array(sx * sz);
    this.surface = new Int16Array(sx * sz);
    this.waterTop = new Int16Array(sx * sz);
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= this.x0 && z >= this.z0 && x < this.x0 + this.sx && z < this.z0 + this.sz && y >= 0 && y < WORLD_HEIGHT;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return Block.AIR;
    return this.blocks[(y * this.sz + (z - this.z0)) * this.sx + (x - this.x0)];
  }

  set(x: number, y: number, z: number, b: number): void {
    if (!this.inside(x, y, z)) return;
    this.blocks[(y * this.sz + (z - this.z0)) * this.sx + (x - this.x0)] = b;
    if (b !== Block.AIR && y > this.maxY) this.maxY = y;
  }

  /** Sets only where the current block is air (or water/plants for `overWater`). */
  place(x: number, y: number, z: number, b: number, overWater = false): void {
    const cur = this.get(x, y, z);
    if (cur === Block.AIR || (overWater && cur === Block.WATER)) this.set(x, y, z, b);
  }

  recomputeTop(): void {
    const layer = this.sx * this.sz;
    for (let y = Math.min(WORLD_HEIGHT - 1, this.maxY + 1); y >= 0; y--) {
      const o = y * layer;
      for (let i = 0; i < layer; i++)
        if (this.blocks[o + i] !== 0) {
          this.maxY = y;
          return;
        }
    }
    this.maxY = 0;
  }

  /** Copies an inner sub-box (e.g. the 32x32 chunk out of a padded meshing box), trimmed to its top. */
  extract(x0: number, z0: number, sx: number, sz: number): { blocks: Uint8Array; top: number; biomes: Uint8Array; surface: Int16Array; water: Int16Array } {
    const ox = x0 - this.x0;
    const oz = z0 - this.z0;
    let top = 0;
    for (let y = this.maxY; y >= 0 && top === 0; y--)
      for (let lz = 0; lz < sz && top === 0; lz++)
        for (let lx = 0; lx < sx; lx++)
          if (this.blocks[(y * this.sz + lz + oz) * this.sx + lx + ox] !== 0) {
            top = y;
            break;
          }
    const out = new Uint8Array((top + 1) * sx * sz);
    for (let y = 0; y <= top; y++)
      for (let lz = 0; lz < sz; lz++) {
        const src = (y * this.sz + lz + oz) * this.sx + ox;
        out.set(this.blocks.subarray(src, src + sx), (y * sz + lz) * sx);
      }
    const biomes = new Uint8Array(sx * sz);
    const surface = new Int16Array(sx * sz);
    const water = new Int16Array(sx * sz);
    for (let lz = 0; lz < sz; lz++)
      for (let lx = 0; lx < sx; lx++) {
        biomes[lz * sx + lx] = this.biomes[(lz + oz) * this.sx + lx + ox];
        surface[lz * sx + lx] = this.surface[(lz + oz) * this.sx + lx + ox];
        water[lz * sx + lx] = this.waterTop[(lz + oz) * this.sx + lx + ox];
      }
    return { blocks: out, top, biomes, surface, water };
  }
}
