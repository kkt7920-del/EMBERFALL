import { CHUNK_SIZE, SEA_LEVEL, WORLD_HEIGHT } from "@shared/config/constants";
import { hash2 } from "@shared/math/rng";
import { BIOMES, BLOCKS, BiomeId, Block, DEFAULT_FOLIAGE, FOLIAGE, LIGHT, OPAQUE, Tile } from "@shared/world/blocks";
import { type ColumnInfo, newColumnInfo } from "@shared/world/column";
import type { TerrainGenerator } from "@shared/world/generator";
import type { VoxelBox } from "@shared/world/column";

/** Buffers for one mesh layer (opaque terrain, water, or flora). */
export interface LayerData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** u, v (block units, tiled with fract) and atlas tile index. */
  atlas: Float32Array;
  /** sky light, block light (0..1). */
  light: Float32Array;
  indices: Uint32Array;
}

export interface ChunkMeshData {
  cx: number;
  cz: number;
  /** 0 = full voxel mesh, otherwise LOD step in blocks. */
  lod: number;
  opaque: LayerData | null;
  water: LayerData | null;
  flora: LayerData | null;
  /** Light emitters (lava, crystals) for ambient particles: x, y, z, kind. */
  glow: Float32Array;
}

class Layer {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  atl: number[] = [];
  lit: number[] = [];
  idx: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, u: number, v: number, tile: number, sky: number, blk: number): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(r, g, b, 1);
    this.atl.push(u, v, tile);
    this.lit.push(sky, blk);
  }

  build(): LayerData | null {
    if (this.empty) return null;
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      atlas: new Float32Array(this.atl),
      light: new Float32Array(this.lit),
      indices: new Uint32Array(this.idx),
    };
  }
}

const AO_CURVE = [0.48, 0.66, 0.83, 1];
/** Directional face shading (top, bottom, x, z), like classic voxel games. */
const SHADE_TOP = 1;
const SHADE_BOTTOM = 0.55;
const SHADE_X = 0.82;
const SHADE_Z = 0.7;

/** Light attenuation per block for propagation: leaves and water let light through, dimmed. */
function lightCost(b: number): number {
  if (b === Block.AIR) return 1;
  if (b === Block.WATER) return 2;
  if (b >= Block.OAK_LEAVES && b <= Block.JUNGLE_LEAVES && (b & 1) === 1) return 3;
  if (b === Block.GLASS || b === Block.ICE) return 1;
  return OPAQUE[b] ? 99 : 1;
}

const isLeaves = (b: number) => b === Block.OAK_LEAVES || b === Block.BIRCH_LEAVES || b === Block.PINE_LEAVES || b === Block.JUNGLE_LEAVES;

/**
 * Meshes the inner 32 x 32 columns of a padded (34 x 34) voxel box. Faces are
 * greedily merged where tile, tint, ambient occlusion and light all match.
 */
export function meshVoxelChunk(box: VoxelBox, cx: number, cz: number, withFlora: boolean): ChunkMeshData {
  const SX = box.sx;
  const SZ = box.sz;
  const H = Math.min(WORLD_HEIGHT, box.maxY + 2);
  const blocks = box.blocks;
  const layer = SX * SZ;
  const at = (x: number, y: number, z: number) => (y >= H || y < 0 ? (y < 0 ? Block.BEDROCK : Block.AIR) : blocks[(y * SZ + z) * SX + x]);

  // ---------------------------------------------------------------- light
  const sky = new Uint8Array(layer * H);
  const blk = new Uint8Array(layer * H);
  const queue: number[] = [];
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      let level = 15;
      let waterRun = 0;
      for (let y = H - 1; y >= 0; y--) {
        const b = blocks[(y * SZ + z) * SX + x];
        const i = (y * SZ + z) * SX + x;
        if (b === Block.AIR) {
          sky[i] = level;
        } else if (b === Block.WATER) {
          waterRun++;
          if (waterRun % 4 === 0) level = Math.max(0, level - 1);
          sky[i] = level;
        } else if (isLeaves(b)) {
          level = Math.max(0, level - 2);
          sky[i] = level;
        } else if (OPAQUE[b]) {
          level = 0;
        } else sky[i] = level;
        if (LIGHT[b]) {
          blk[i] = LIGHT[b];
          queue.push(i);
        }
      }
    }
  // Spread sky light sideways and down into caves / under overhangs
  const skyQueue: number[] = [];
  for (let y = 0; y < H; y++)
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const i = (y * SZ + z) * SX + x;
        const l = sky[i];
        if (l < 2) continue;
        if (
          (x > 0 && sky[i - 1] < l - 1 && lightCost(blocks[i - 1]) < 10) ||
          (x < SX - 1 && sky[i + 1] < l - 1 && lightCost(blocks[i + 1]) < 10) ||
          (z > 0 && sky[i - SX] < l - 1 && lightCost(blocks[i - SX]) < 10) ||
          (z < SZ - 1 && sky[i + SX] < l - 1 && lightCost(blocks[i + SX]) < 10) ||
          (y > 0 && sky[i - layer] < l - 1 && lightCost(blocks[i - layer]) < 10)
        )
          skyQueue.push(i);
      }
  const spread = (arr: Uint8Array, q: number[]) => {
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const l = arr[i];
      if (l <= 1) continue;
      const x = i % SX;
      const z = Math.floor(i / SX) % SZ;
      const y = Math.floor(i / layer);
      const visit = (j: number) => {
        const cost = lightCost(blocks[j]);
        if (cost >= 10) return;
        const nl = l - cost;
        if (nl > arr[j]) {
          arr[j] = nl;
          q.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < SX - 1) visit(i + 1);
      if (z > 0) visit(i - SX);
      if (z < SZ - 1) visit(i + SX);
      if (y > 0) visit(i - layer);
      if (y < H - 1) visit(i + layer);
    }
  };
  spread(sky, skyQueue);
  spread(blk, queue);

  const skyAt = (x: number, y: number, z: number) => (y >= H ? 15 : y < 0 ? 0 : sky[(y * SZ + z) * SX + x]);
  const blkAt = (x: number, y: number, z: number) => (y >= H || y < 0 ? 0 : blk[(y * SZ + z) * SX + x]);

  // ---------------------------------------------------------------- faces
  const opaque = new Layer();
  const water = new Layer();
  const ox = 1;
  const oz = 1;
  const dims = [SX, H, SZ];
  const lo = [1, 0, 1];
  const hi = [SX - 1, Math.min(H, WORLD_HEIGHT), SZ - 1];

  const tintOf = (b: number, lx: number, lz: number, face: number): [number, number, number] => {
    const info = BLOCKS[b];
    if (info.biomeTint === "all" || (info.biomeTint === "top" && face === 1)) {
      const biome = BIOMES[box.biomes[lz * SX + lx]];
      return FOLIAGE[biome] ?? DEFAULT_FOLIAGE;
    }
    return info.tint ?? [1, 1, 1];
  };

  // Per-face key arrays reused for every slice
  const maxMask = Math.max(SX, H, SZ) ** 2;
  const maskKey = new Int32Array(maxMask);
  const maskLight = new Int32Array(maxMask);
  const maskBlock = new Int32Array(maxMask);
  const maskTint = new Int32Array(maxMask);
  const tints: [number, number, number][] = [];
  const tintIndex = new Map<string, number>();
  const tintId = (t: [number, number, number]) => {
    const k = `${t[0]},${t[1]},${t[2]}`;
    let id = tintIndex.get(k);
    if (id === undefined) {
      id = tints.length;
      tints.push(t);
      tintIndex.set(k, id);
    }
    return id;
  };

  const c = [0, 0, 0];
  const n = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const nu = hi[u] - lo[u];
    const nv = hi[v] - lo[v];
    for (const sign of [1, -1]) {
      const faceDir = d === 1 ? (sign > 0 ? 1 : 2) : 0;
      const shade = d === 1 ? (sign > 0 ? SHADE_TOP : SHADE_BOTTOM) : d === 0 ? SHADE_X : SHADE_Z;
      for (const pass of [0, 1]) {
        // pass 0: opaque blocks, pass 1: water
        const out = pass === 0 ? opaque : water;
        for (let s = lo[d]; s < hi[d]; s++) {
          let any = false;
          for (let j = 0; j < nv; j++)
            for (let i = 0; i < nu; i++) {
              c[d] = s;
              c[u] = lo[u] + i;
              c[v] = lo[v] + j;
              const b = at(c[0], c[1], c[2]);
              const m = j * nu + i;
              maskKey[m] = 0;
              if (pass === 0 ? !OPAQUE[b] : b !== Block.WATER) continue;
              n[0] = c[0];
              n[1] = c[1];
              n[2] = c[2];
              n[d] += sign;
              if (n[d] < 0 || n[d] >= dims[d]) {
                if (d !== 1) continue;
              }
              const nb = at(n[0], n[1], n[2]);
              if (OPAQUE[nb]) continue;
              if (pass === 1 && nb === Block.WATER) continue;
              // Vertex AO + light from the four cells around each corner on the open side
              let aoKey = 0;
              let lightKey = 0;
              for (let k = 0; k < 4; k++) {
                const du = k === 1 || k === 2 ? 1 : -1;
                const dv = k >= 2 ? 1 : -1;
                const p1 = [n[0], n[1], n[2]];
                p1[u] += du;
                const p2 = [n[0], n[1], n[2]];
                p2[v] += dv;
                const p3 = [n[0], n[1], n[2]];
                p3[u] += du;
                p3[v] += dv;
                const inb = (p: number[]) => p[0] >= 0 && p[0] < SX && p[2] >= 0 && p[2] < SZ;
                const o1 = inb(p1) ? OPAQUE[at(p1[0], p1[1], p1[2])] : 0;
                const o2 = inb(p2) ? OPAQUE[at(p2[0], p2[1], p2[2])] : 0;
                const o3 = inb(p3) ? OPAQUE[at(p3[0], p3[1], p3[2])] : 0;
                const ao = pass === 1 ? 3 : o1 && o2 ? 0 : 3 - (o1 + o2 + o3);
                let sl = skyAt(n[0], n[1], n[2]);
                let bl = blkAt(n[0], n[1], n[2]);
                let cnt = 1;
                if (!o1 && inb(p1)) {
                  sl += skyAt(p1[0], p1[1], p1[2]);
                  bl += blkAt(p1[0], p1[1], p1[2]);
                  cnt++;
                }
                if (!o2 && inb(p2)) {
                  sl += skyAt(p2[0], p2[1], p2[2]);
                  bl += blkAt(p2[0], p2[1], p2[2]);
                  cnt++;
                }
                if (!o3 && !(o1 && o2) && inb(p3)) {
                  sl += skyAt(p3[0], p3[1], p3[2]);
                  bl += blkAt(p3[0], p3[1], p3[2]);
                  cnt++;
                }
                aoKey |= ao << (k * 2);
                lightKey |= ((Math.round(sl / cnt) & 15) | ((Math.round(bl / cnt) & 15) << 4)) << (k * 8);
              }
              const info = BLOCKS[b];
              const tile = faceDir === 1 ? info.top : faceDir === 2 ? info.bottom : info.side;
              const tid = tintId(tintOf(b, c[0], c[2], faceDir));
              maskKey[m] = 1 + tile + (tid << 8) + (aoKey << 20);
              maskLight[m] = lightKey;
              maskBlock[m] = b;
              maskTint[m] = tid;
              any = true;
            }
          if (!any) continue;

          // Greedy rectangles
          for (let j = 0; j < nv; j++)
            for (let i = 0; i < nu; ) {
              const m = j * nu + i;
              const key = maskKey[m];
              if (!key) {
                i++;
                continue;
              }
              const lk = maskLight[m];
              let w = 1;
              while (i + w < nu && maskKey[m + w] === key && maskLight[m + w] === lk) w++;
              let h = 1;
              grow: while (j + h < nv) {
                for (let k = 0; k < w; k++) {
                  const mm = (j + h) * nu + i + k;
                  if (maskKey[mm] !== key || maskLight[mm] !== lk) break grow;
                }
                h++;
              }
              for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) maskKey[(j + jj) * nu + i + ii] = 0;

              const b = maskBlock[m];
              const info = BLOCKS[b];
              const tile = faceDir === 1 ? info.top : faceDir === 2 ? info.bottom : info.side;
              const tint = tints[maskTint[m]];
              const aoKey = (key - 1 - tile - (maskTint[m] << 8)) >> 20;
              const plane = s + (sign > 0 ? 1 : 0);
              const base = out.pos.length / 3;
              const nrm = [0, 0, 0];
              nrm[d] = sign;
              const corners = sign > 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
              const aos: number[] = [];
              for (const k of corners) {
                const cu = k === 1 || k === 2 ? i + w : i;
                const cv = k >= 2 ? j + h : j;
                const p = [0, 0, 0];
                p[d] = plane;
                p[u] = lo[u] + cu;
                p[v] = lo[v] + cv;
                // Lowered water surface
                let py = p[1];
                if (pass === 1 && d === 1 && sign > 0) py -= 0.12;
                const ao = AO_CURVE[(aoKey >> (k * 2)) & 3];
                aos.push(ao);
                const lv = (lk >> (k * 8)) & 255;
                const sl = (lv & 15) / 15;
                const bl = ((lv >> 4) & 15) / 15;
                const x = p[0] - ox;
                const z = p[2] - oz;
                const tu = d === 0 ? p[2] : p[0];
                const tv = d === 1 ? p[2] : p[1];
                const k2 = shade * ao;
                out.vertex(x, py, z, nrm[0], nrm[1], nrm[2], tint[0] * k2, tint[1] * k2, tint[2] * k2, tu + cx * CHUNK_SIZE, tv + (d === 1 ? cz * CHUNK_SIZE : 0), tile, sl, bl);
              }
              // Flip the diagonal where AO is uneven to avoid streaks
              if (aos[0] + aos[2] < aos[1] + aos[3]) out.idx.push(base + 1, base + 3, base + 2, base + 1, base, base + 3);
              else out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
              i += w;
            }
        }
      }
    }
  }

  // ---------------------------------------------------------------- flora + glow
  const flora = new Layer();
  const glow: number[] = [];
  for (let lz = 1; lz < SZ - 1; lz++)
    for (let lx = 1; lx < SX - 1; lx++) {
      const wx = box.x0 + lx;
      const wz = box.z0 + lz;
      const biome = box.biomes[lz * SX + lx];
      let surfaceDone = false;
      for (let y = H - 2; y >= 1; y--) {
        const b = at(lx, y, lz);
        if (b === Block.AIR) continue;
        if (LIGHT[b] >= 11 && hash2(wx * 3 + y, wz, 7) < 0.05) glow.push(lx - ox + 0.5, y + 1, lz - oz + 0.5, b === Block.LAVA ? 1 : 0);
        if (b === Block.WATER) {
          if (!withFlora || surfaceDone) continue;
          // Find the sea floor below this water column
          let fy = y;
          while (fy > 1 && at(lx, fy, lz) === Block.WATER) fy--;
          const floor = at(lx, fy, lz);
          const depth = y - fy;
          surfaceDone = true;
          if (depth >= 2 && (floor === Block.SAND || floor === Block.GRAVEL || floor === Block.CLAY)) {
            const r = hash2(wx, wz, 31);
            const deepSea = biome === BiomeId.open_ocean || biome === BiomeId.cold_ocean || biome === BiomeId.deep_ocean || biome === BiomeId.lake;
            if (deepSea && r < 0.07 && depth >= 4) addFlora(flora, lx - ox, fy + 1, lz - oz, Tile.FLORA_KELP, Math.min(depth - 1, 3 + Math.floor(hash2(wx, wz, 32) * 9)), skyAt(lx, fy + 1, lz), wx, wz);
            else if (r < 0.28) addFlora(flora, lx - ox, fy + 1, lz - oz, Tile.FLORA_SEAGRASS, 0.9, skyAt(lx, fy + 1, lz), wx, wz);
          }
          y = fy;
          continue;
        }
        if (!OPAQUE[b]) continue;
        const above = at(lx, y + 1, lz);
        if (above !== Block.AIR) continue;
        const open = skyAt(lx, y + 1, lz);
        if (!surfaceDone) {
          surfaceDone = true;
          if (withFlora) placeSurfaceFlora(flora, b, biome, lx - ox, y + 1, lz - oz, wx, wz, open);
          continue;
        }
        // Cave floors: glowing mushrooms in the dark
        if (withFlora && open < 4 && (b === Block.STONE || b === Block.DEEPSLATE || b === Block.GRAVEL || b === Block.MOSS) && at(lx, y + 2, lz) === Block.AIR) {
          if (hash2(wx * 7 + y, wz, 41) < 0.018) addFlora(flora, lx - ox, y + 1, lz - oz, Tile.FLORA_GLOW_SHROOM, 0.55, open, wx, wz);
        }
      }
    }

  return { cx, cz, lod: 0, opaque: opaque.build(), water: water.build(), flora: flora.build(), glow: new Float32Array(glow) };
}

function placeSurfaceFlora(out: Layer, b: number, biome: number, x: number, y: number, z: number, wx: number, wz: number, sky: number): void {
  const r = hash2(wx, wz, 77);
  const B = BiomeId;
  if (b === Block.GRASS || b === Block.PODZOL || b === Block.MOSS) {
    let tile = -1;
    let h = 0.8;
    switch (biome) {
      case B.plains:
      case B.town:
      case B.island:
        if (r < 0.06) tile = [Tile.FLORA_FLOWER_RED, Tile.FLORA_FLOWER_YELLOW, Tile.FLORA_FLOWER_BLUE][Math.floor(hash2(wx >> 3, wz >> 3, 79) * 3)];
        else if (r < (biome === B.town ? 0.12 : 0.32)) tile = Tile.FLORA_GRASS;
        break;
      case B.forest_edge:
        if (r < 0.03) tile = Tile.FLORA_FLOWER_YELLOW;
        else if (r < 0.1) tile = Tile.FLORA_FERN;
        else if (r < 0.32) tile = Tile.FLORA_GRASS;
        break;
      case B.forest:
        if (r < 0.025) tile = hash2(wx, wz, 80) < 0.5 ? Tile.FLORA_MUSHROOM_RED : Tile.FLORA_MUSHROOM_BROWN;
        else if (r < 0.18) tile = Tile.FLORA_FERN;
        else if (r < 0.32) tile = Tile.FLORA_GRASS;
        break;
      case B.deep_forest:
        if (r < 0.05) tile = hash2(wx, wz, 80) < 0.5 ? Tile.FLORA_MUSHROOM_RED : Tile.FLORA_MUSHROOM_BROWN;
        else if (r < 0.26) tile = Tile.FLORA_FERN;
        break;
      case B.hills:
      case B.mountain:
      case B.river:
      case B.lake:
      case B.ruins:
        if (r < 0.025) tile = Tile.FLORA_FLOWER_BLUE;
        else if (r < 0.22) tile = Tile.FLORA_GRASS;
        break;
      default:
        if (r < 0.15) tile = Tile.FLORA_GRASS;
    }
    if (tile === Tile.FLORA_FERN) h = 0.95;
    if (tile === Tile.FLORA_MUSHROOM_RED || tile === Tile.FLORA_MUSHROOM_BROWN) h = 0.5;
    if (tile >= 0) addFlora(out, x, y, z, tile, h, sky, wx, wz);
  } else if (b === Block.SAND && (biome === B.beach || biome === B.river || biome === B.lake) && y <= SEA_LEVEL + 2) {
    if (r < 0.06) addFlora(out, x, y, z, Tile.FLORA_REED, 1.6, sky, wx, wz);
  } else if (b === Block.SAND && r < 0.012) addFlora(out, x, y, z, Tile.FLORA_DEAD_BUSH, 0.7, sky, wx, wz);
  else if (b === Block.ASH && r < 0.02) addFlora(out, x, y, z, Tile.FLORA_DEAD_BUSH, 0.7, sky, wx, wz);
}

/** Two crossed quads; v runs in blocks so tall plants (kelp, reeds) tile vertically. */
function addFlora(out: Layer, x: number, y: number, z: number, tile: number, height: number, sky: number, wx: number, wz: number): void {
  const jx = 0.5 + (hash2(wx, wz, 91) - 0.5) * 0.5;
  const jz = 0.5 + (hash2(wx, wz, 92) - 0.5) * 0.5;
  const w = 0.46;
  const sl = sky / 15;
  const shade = 0.85 + hash2(wx, wz, 93) * 0.15;
  for (const [ax, az] of [
    [1, 1],
    [1, -1],
  ]) {
    const dx = (ax * w) / Math.SQRT2;
    const dz = (az * w) / Math.SQRT2;
    const base = out.pos.length / 3;
    const pts: [number, number, number, number, number][] = [
      [x + jx - dx, y, z + jz - dz, 0, 0],
      [x + jx + dx, y, z + jz + dz, 1, 0],
      [x + jx + dx, y + height, z + jz + dz, 1, height],
      [x + jx - dx, y + height, z + jz - dz, 0, height],
    ];
    for (const p of pts) out.vertex(p[0], p[1], p[2], 0, 1, 0, shade, shade, shade, p[3], p[4], tile, sl, tile === Tile.FLORA_GLOW_SHROOM ? 0.75 : 0);
    out.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/**
 * Far-distance mesh: column tops and walls sampled every `step` blocks from
 * the 2D generator (no caves), keeping the stepped voxel silhouette of
 * mountains, forests and coastlines on the horizon.
 */
export function meshLodTile(gen: TerrainGenerator, tx: number, tz: number, size: number, step: number): ChunkMeshData {
  const n = size / step;
  const W = n + 2;
  const H = new Int16Array(W * W);
  const T = new Uint8Array(W * W);
  const L = new Int16Array(W * W);
  const Bm = new Uint8Array(W * W);
  const col: ColumnInfo = newColumnInfo();
  const ox = tx * size;
  const oz = tz * size;
  for (let j = -1; j <= n; j++)
    for (let i = -1; i <= n; i++) {
      const wx = ox + i * step + (step >> 1);
      const wz = oz + j * step + (step >> 1);
      const lc = gen.lodColumn(wx, wz, col);
      const k = (j + 1) * W + (i + 1);
      let h = lc.h;
      let top = lc.top;
      if (lc.canopy) {
        h += lc.canopy;
        top = col.biome === BiomeId.snow_mountain || col.biome === BiomeId.mountain ? Block.PINE_LEAVES : Block.OAK_LEAVES;
      }
      if (col.top === Block.STONE || (col.mountain > 0.3 && hash2(wx >> 3, wz >> 3, 5) < 0.3 && !lc.canopy)) top = col.biome === BiomeId.snow_mountain ? Block.SNOW : top;
      H[k] = h;
      T[k] = top;
      L[k] = col.water;
      Bm[k] = col.biome;
    }
  const at = (i: number, j: number) => (j + 1) * W + (i + 1);
  const out = new Layer();
  const water = new Layer();
  const quad = (layer: Layer, p: [number, number, number][], nrm: [number, number, number], uv: [number, number][], tile: number, c: [number, number, number], sky = 1) => {
    const base = layer.pos.length / 3;
    for (let q = 0; q < 4; q++) layer.vertex(p[q][0], p[q][1], p[q][2], nrm[0], nrm[1], nrm[2], c[0], c[1], c[2], uv[q][0], uv[q][1], tile, sky, 0);
    layer.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  const tint = (b: number, biome: number, face: number): [number, number, number] => {
    const info = BLOCKS[b];
    if (info.biomeTint === "all" || (info.biomeTint === "top" && face === 1)) return FOLIAGE[BIOMES[biome]] ?? DEFAULT_FOLIAGE;
    return info.tint ?? [1, 1, 1];
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = at(i, j);
      const h = H[k] + 1;
      const b = T[k];
      const info = BLOCKS[b];
      const x0 = i * step;
      const z0 = j * step;
      const x1 = x0 + step;
      const z1 = z0 + step;
      const tc = tint(b, Bm[k], 1);
      quad(out, [[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]], [0, 1, 0], [[ox + x0, oz + z0], [ox + x0, oz + z1], [ox + x1, oz + z1], [ox + x1, oz + z0]], info.top, tc);
      // Walls toward lower neighbours
      for (const [di, dj, nx, nz] of [[1, 0, 1, 0], [-1, 0, -1, 0], [0, 1, 0, 1], [0, -1, 0, -1]] as const) {
        const nh = H[at(i + di, j + dj)] + 1;
        if (nh >= h) continue;
        const shade = nx !== 0 ? SHADE_X : SHADE_Z;
        const ts = tint(b, Bm[k], 0);
        const c: [number, number, number] = [ts[0] * shade, ts[1] * shade, ts[2] * shade];
        const sideTile = info.side;
        const below = BLOCKS[b === Block.GRASS || b === Block.SNOWY_GRASS || b === Block.PODZOL ? Block.DIRT : b === Block.OAK_LEAVES || b === Block.PINE_LEAVES ? b : b].side;
        const y0 = nh;
        const y1 = h;
        const fx = nx > 0 ? x1 : x0;
        const fz = nz > 0 ? z1 : z0;
        const band = Math.min(1, y1 - y0);
        for (const [ya, yb, t] of [[y1 - band, y1, sideTile], [y0, y1 - band, below]] as const) {
          if (yb <= ya) continue;
          if (nx !== 0) {
            const p: [number, number, number][] = nx > 0 ? [[fx, ya, z0], [fx, yb, z0], [fx, yb, z1], [fx, ya, z1]] : [[fx, ya, z1], [fx, yb, z1], [fx, yb, z0], [fx, ya, z0]];
            quad(out, p, [nx, 0, 0], p.map((q) => [oz + q[2], q[1]] as [number, number]), t, c);
          } else {
            const p: [number, number, number][] = nz > 0 ? [[x1, ya, fz], [x1, yb, fz], [x0, yb, fz], [x0, ya, fz]] : [[x0, ya, fz], [x0, yb, fz], [x1, yb, fz], [x1, ya, fz]];
            quad(out, p, [0, 0, nz], p.map((q) => [ox + q[0], q[1]] as [number, number]), t, c);
          }
        }
      }
      if (L[k] >= 0 && L[k] >= H[k]) {
        const wy = L[k] + 1 - 0.12;
        quad(water, [[x0, wy, z0], [x0, wy, z1], [x1, wy, z1], [x1, wy, z0]], [0, 1, 0], [[ox + x0, oz + z0], [ox + x0, oz + z1], [ox + x1, oz + z1], [ox + x1, oz + z0]], Tile.WATER, [1, 1, 1]);
      }
    }
  return { cx: tx, cz: tz, lod: step, opaque: out.build(), water: water.build(), flora: null, glow: new Float32Array(0) };
}
