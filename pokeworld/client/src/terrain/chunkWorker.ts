/// <reference lib="webworker" />
import type { RegionDef } from "@shared/types/content";
import { BIOMES, BIOME_COLORS } from "@shared/world/blocks";
import { newColumnInfo } from "@shared/world/column";
import { TerrainGenerator } from "@shared/world/generator";
import { type ChunkMeshData, meshLodTile, meshVoxelChunk } from "./voxelMesher";

export type WorkerRequest =
  | { type: "init"; region: RegionDef }
  | { type: "build"; id: number; cx: number; cz: number; flora: boolean }
  | { type: "lod"; id: number; tx: number; tz: number; size: number; step: number }
  | { type: "map"; id: number; minX: number; minZ: number; size: number; scale: number };

export interface ChunkVoxelPayload {
  blocks: Uint8Array;
  top: number;
  biomes: Uint8Array;
  surface: Int16Array;
  water: Int16Array;
}

export type WorkerReply =
  | { type: "chunk"; id: number; mesh: ChunkMeshData; voxels: ChunkVoxelPayload | null; ms: number }
  | { type: "map"; id: number; pixels: Uint8ClampedArray; size: number };

let gen: TerrainGenerator | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function transferables(mesh: ChunkMeshData): Transferable[] {
  const out: Transferable[] = [mesh.glow.buffer];
  for (const l of [mesh.opaque, mesh.water, mesh.flora]) {
    if (!l) continue;
    out.push(l.positions.buffer, l.normals.buffer, l.colors.buffer, l.atlas.buffer, l.light.buffer, l.indices.buffer);
  }
  return out;
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    gen = new TerrainGenerator(msg.region);
    return;
  }
  if (!gen) return;

  if (msg.type === "build") {
    const t0 = performance.now();
    const box = gen.generateBox(msg.cx * 32 - 1, msg.cz * 32 - 1, 34, 34);
    const mesh = meshVoxelChunk(box, msg.cx, msg.cz, msg.flora);
    const voxels = box.extract(msg.cx * 32, msg.cz * 32, 32, 32);
    const reply: WorkerReply = { type: "chunk", id: msg.id, mesh, voxels, ms: performance.now() - t0 };
    ctx.postMessage(reply, [...transferables(mesh), voxels.blocks.buffer, voxels.biomes.buffer, voxels.surface.buffer, voxels.water.buffer]);
    return;
  }

  if (msg.type === "lod") {
    const t0 = performance.now();
    const mesh = meshLodTile(gen, msg.tx, msg.tz, msg.size, msg.step);
    const reply: WorkerReply = { type: "chunk", id: msg.id, mesh, voxels: null, ms: performance.now() - t0 };
    ctx.postMessage(reply, transferables(mesh));
    return;
  }

  if (msg.type === "map") {
    const px = new Uint8ClampedArray(msg.size * msg.size * 4);
    const col = newColumnInfo();
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const colors = BIOMES.map((b) => rgb(BIOME_COLORS[b]));
    for (let y = 0; y < msg.size; y++)
      for (let x = 0; x < msg.size; x++) {
        // Image row 0 is north (max z)
        const wx = msg.minX + x * msg.scale;
        const wz = msg.minZ + (msg.size - 1 - y) * msg.scale;
        gen.column(wx, wz, col);
        let [r, g, b] = colors[col.biome];
        if (col.water >= 0) {
          const depth = Math.min(1, (col.water - col.h) / 40);
          [r, g, b] = [r * (1 - depth * 0.5), g * (1 - depth * 0.4), b * (1 - depth * 0.2)];
        } else {
          // Hill shading from the slope toward the north-west light
          const e = gen.column(wx + msg.scale, wz + msg.scale, newColumnInfo()).h - col.h;
          const shade = Math.max(0.6, Math.min(1.25, 0.95 - e * 0.04 + (col.h - 68) / 400));
          [r, g, b] = [r * shade, g * shade, b * shade];
        }
        const k = (y * msg.size + x) * 4;
        px[k] = r;
        px[k + 1] = g;
        px[k + 2] = b;
        px[k + 3] = 255;
      }
    const reply: WorkerReply = { type: "map", id: msg.id, pixels: px, size: msg.size };
    ctx.postMessage(reply, [px.buffer]);
  }
};
