import { CHUNK_SIZE } from "@shared/config/constants";
import { hash2 } from "@shared/math/rng";
import { BLOCKS, Block, Tile } from "@shared/world/blocks";
import { type Column, type ZoneTerrain, newColumn } from "@shared/world/terrain";

export interface ChunkMeshData {
  zone: string;
  cx: number;
  cz: number;
  lod: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Per vertex: u, v (metres, tiled with fract) and atlas tile index. */
  atlas: Float32Array;
  indices: Uint32Array;
  water: { positions: Float32Array; indices: Uint32Array } | null;
  /** Tree canopies: x, y, z (chunk-local), size. */
  trees: Float32Array;
  /** Grass/flowers/reeds: x, y, z, kind. */
  flora: Float32Array;
  /** Glowing crystal outcrops: x, y, z. */
  crystals: Float32Array;
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  atl: number[] = [];
  idx: number[] = [];

  quad(
    p: [number, number, number][],
    n: [number, number, number],
    uv: [number, number][],
    tile: number,
    c: [number, number, number],
  ): void {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(c[0], c[1], c[2], 1);
      this.atl.push(uv[i][0], uv[i][1], tile);
    }
    // Babylon treats clockwise winding as front-facing; vertices are given counter-clockwise
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

const SHADE = { top: 1, x: 0.84, z: 0.72 };

/**
 * Builds render buffers for one chunk. `lod` is the column step (1, 2 or 4):
 * far chunks sample fewer columns and drop trees and flora.
 *
 * Faces are greedily merged; texture tiling across a merged face is done in
 * the shader (uv in metres, fract() into the atlas cell).
 */
export function meshChunk(terrain: ZoneTerrain, cx: number, cz: number, lod: number, withFlora: boolean): ChunkMeshData {
  const s = lod;
  const n = CHUNK_SIZE / s;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  const W = n + 2;

  const H = new Int16Array(W * W);
  const T = new Uint8Array(W * W);
  const S = new Uint8Array(W * W);
  const B = new Uint8Array(W * W);
  const trees: number[] = [];
  const flora: number[] = [];
  const crystals: number[] = [];

  const col: Column = newColumn();
  for (let j = -1; j <= n; j++) {
    for (let i = -1; i <= n; i++) {
      const wx = ox + i * s + (s > 1 ? (s >> 1) : 0);
      const wz = oz + j * s + (s > 1 ? (s >> 1) : 0);
      terrain.column(wx, wz, col);
      const k = (j + 1) * W + (i + 1);
      let h = col.h;
      let top = col.top;
      if (col.tree > 0) {
        if (s === 1 && i >= 0 && j >= 0 && i < n && j < n) trees.push(i + 0.5, h, j + 0.5, 3 + (hash2(wx, wz, 5) > 0.5 ? 1 : 0));
        if (s > 1) {
          h -= col.tree;
          top = Block.GRASS;
        }
      }
      H[k] = h;
      T[k] = top;
      S[k] = col.sub;
      B[k] = col.biome;

      if (s === 1 && i >= 0 && j >= 0 && i < n && j < n) {
        if (top === Block.CRYSTAL) crystals.push(i + 0.5, h + 0.35, j + 0.5);
        if (withFlora && (top === Block.GRASS || top === Block.FOREST_GRASS) && col.tree === 0) {
          const r = hash2(wx, wz, 77);
          const density = top === Block.FOREST_GRASS ? 0.05 : 0.09;
          if (r < density) {
            const kind = r < density * 0.55 ? 0 : r < density * 0.78 ? 1 : 2;
            flora.push(i + 0.2 + hash2(wx, wz, 78) * 0.6, h, j + 0.2 + hash2(wx, wz, 79) * 0.6, kind);
          }
        }
      }
    }
  }

  const at = (i: number, j: number) => (j + 1) * W + (i + 1);
  const b = new Builder();

  // ---- top faces (greedy 2D) ----
  const visited = new Uint8Array(n * n);
  const keyAt = (i: number, j: number) => H[at(i, j)] * 256 + T[at(i, j)];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (visited[j * n + i]) continue;
      const key = keyAt(i, j);
      let w = 1;
      while (i + w < n && !visited[j * n + i + w] && keyAt(i + w, j) === key) w++;
      let d = 1;
      grow: while (j + d < n) {
        for (let k = 0; k < w; k++) if (visited[(j + d) * n + i + k] || keyAt(i + k, j + d) !== key) break grow;
        d++;
      }
      for (let jj = 0; jj < d; jj++) for (let ii = 0; ii < w; ii++) visited[(j + jj) * n + i + ii] = 1;

      const info = BLOCKS[T[at(i, j)]];
      const y = H[at(i, j)];
      const x0 = i * s;
      const x1 = (i + w) * s;
      const z0 = j * s;
      const z1 = (j + d) * s;
      const tint = info.tint;
      b.quad(
        [
          [x0, y, z0],
          [x0, y, z1],
          [x1, y, z1],
          [x1, y, z0],
        ],
        [0, 1, 0],
        [
          [ox + x0, oz + z0],
          [ox + x0, oz + z1],
          [ox + x1, oz + z1],
          [ox + x1, oz + z0],
        ],
        info.top,
        [tint[0] * SHADE.top, tint[1] * SHADE.top, tint[2] * SHADE.top],
      );
    }
  }

  // ---- side faces (1D runs along each edge line) ----
  const wall = (
    axis: "x" | "z",
    dir: 1 | -1,
    line: number,
    from: number,
    to: number,
    y0: number,
    y1: number,
    tile: number,
    color: [number, number, number],
  ) => {
    // Face plane sits on the cell boundary in the direction of the neighbour
    const shade = axis === "x" ? SHADE.x : SHADE.z;
    const c: [number, number, number] = [color[0] * shade, color[1] * shade, color[2] * shade];
    if (axis === "x") {
      const x = (dir > 0 ? line + 1 : line) * s;
      const za = from * s;
      const zb = to * s;
      const p: [number, number, number][] =
        dir > 0
          ? [
              [x, y0, za],
              [x, y1, za],
              [x, y1, zb],
              [x, y0, zb],
            ]
          : [
              [x, y0, zb],
              [x, y1, zb],
              [x, y1, za],
              [x, y0, za],
            ];
      const uv: [number, number][] = p.map((q) => [oz + q[2], q[1]]);
      b.quad(p, [dir, 0, 0], uv, tile, c);
    } else {
      const z = (dir > 0 ? line + 1 : line) * s;
      const xa = from * s;
      const xb = to * s;
      const p: [number, number, number][] =
        dir > 0
          ? [
              [xb, y0, z],
              [xb, y1, z],
              [xa, y1, z],
              [xa, y0, z],
            ]
          : [
              [xa, y0, z],
              [xa, y1, z],
              [xb, y1, z],
              [xb, y0, z],
            ];
      const uv: [number, number][] = p.map((q) => [ox + q[0], q[1]]);
      b.quad(p, [0, 0, dir], uv, tile, c);
    }
  };

  const emitRun = (axis: "x" | "z", dir: 1 | -1, line: number, from: number, to: number, h: number, nh: number, top: number, sub: number) => {
    const info = BLOCKS[top];
    const topBand = Math.min(1, h - nh);
    wall(axis, dir, line, from, to, h - topBand, h, info.sideTop, info.tint);
    // Below the top metre the column shows its sub block (dirt under grass, wall under a roof)
    if (h - topBand > nh) wall(axis, dir, line, from, to, nh, h - topBand, BLOCKS[sub].side === info.side ? info.side : BLOCKS[sub].side, [1, 1, 1]);
  };

  for (const dir of [1, -1] as const) {
    // Faces facing +x / -x: walk z along each column line i
    for (let i = 0; i < n; i++) {
      let runStart = -1;
      let runKey = "";
      let run: [number, number, number, number] = [0, 0, 0, 0];
      for (let j = 0; j <= n; j++) {
        let key = "";
        if (j < n) {
          const h = H[at(i, j)];
          const nh = H[at(i + dir, j)];
          if (nh < h) key = `${h}|${nh}|${T[at(i, j)]}|${S[at(i, j)]}`;
        }
        if (key !== runKey) {
          if (runKey) emitRun("x", dir, i, runStart, j, run[0], run[1], run[2], run[3]);
          runKey = key;
          runStart = j;
          if (key) run = [H[at(i, j)], H[at(i + dir, j)], T[at(i, j)], S[at(i, j)]];
        }
      }
    }
    // Faces facing +z / -z: walk x along each row line j
    for (let j = 0; j < n; j++) {
      let runStart = -1;
      let runKey = "";
      let run: [number, number, number, number] = [0, 0, 0, 0];
      for (let i = 0; i <= n; i++) {
        let key = "";
        if (i < n) {
          const h = H[at(i, j)];
          const nh = H[at(i, j + dir)];
          if (nh < h) key = `${h}|${nh}|${T[at(i, j)]}|${S[at(i, j)]}`;
        }
        if (key !== runKey) {
          if (runKey) emitRun("z", dir, j, runStart, i, run[0], run[1], run[2], run[3]);
          runKey = key;
          runStart = i;
          if (key) run = [H[at(i, j)], H[at(i, j + dir)], T[at(i, j)], S[at(i, j)]];
        }
      }
    }
  }

  // ---- water surface ----
  let water: ChunkMeshData["water"] = null;
  const level = terrain.waterLevel;
  if (level !== null) {
    const wp: number[] = [];
    const wi: number[] = [];
    const wv = new Uint8Array(n * n);
    const wet = (i: number, j: number) => H[at(i, j)] < level;
    const y = level - 0.12;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        if (wv[j * n + i] || !wet(i, j)) continue;
        let w = 1;
        while (i + w < n && !wv[j * n + i + w] && wet(i + w, j)) w++;
        let d = 1;
        grow: while (j + d < n) {
          for (let k = 0; k < w; k++) if (wv[(j + d) * n + i + k] || !wet(i + k, j + d)) break grow;
          d++;
        }
        for (let jj = 0; jj < d; jj++) for (let ii = 0; ii < w; ii++) wv[(j + jj) * n + i + ii] = 1;
        const base = wp.length / 3;
        const x0 = i * s;
        const x1 = (i + w) * s;
        const z0 = j * s;
        const z1 = (j + d) * s;
        wp.push(x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0);
        wi.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    if (wp.length) water = { positions: new Float32Array(wp), indices: new Uint32Array(wi) };
  }

  return {
    zone: terrain.id,
    cx,
    cz,
    lod,
    positions: new Float32Array(b.pos),
    normals: new Float32Array(b.nrm),
    colors: new Float32Array(b.col),
    atlas: new Float32Array(b.atl),
    indices: new Uint32Array(b.idx),
    water,
    trees: new Float32Array(trees),
    flora: new Float32Array(flora),
    crystals: new Float32Array(crystals),
  };
}

export { Tile };
