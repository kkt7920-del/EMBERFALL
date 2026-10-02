/// <reference lib="webworker" />
import type { RegionDef } from "@shared/types/content";
import { BIOMES, BIOME_COLORS } from "@shared/world/blocks";
import { WorldTerrain, newColumn } from "@shared/world/terrain";
import { meshChunk } from "./mesher";

export type WorkerRequest =
  | { type: "init"; region: RegionDef }
  | { type: "build"; id: number; zone: string; cx: number; cz: number; lod: number; flora: boolean }
  | { type: "map"; id: number; zone: string; minX: number; minZ: number; size: number; scale: number };

let terrain: WorldTerrain | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    terrain = new WorldTerrain(msg.region);
    return;
  }
  if (!terrain) return;

  if (msg.type === "build") {
    const data = meshChunk(terrain.zone(msg.zone), msg.cx, msg.cz, msg.lod, msg.flora);
    const transfer: Transferable[] = [
      data.positions.buffer,
      data.normals.buffer,
      data.colors.buffer,
      data.atlas.buffer,
      data.indices.buffer,
      data.trees.buffer,
      data.flora.buffer,
      data.crystals.buffer,
    ];
    if (data.water) transfer.push(data.water.positions.buffer, data.water.indices.buffer);
    ctx.postMessage({ type: "chunk", id: msg.id, data }, transfer);
    return;
  }

  if (msg.type === "map") {
    const zone = terrain.zone(msg.zone);
    const px = new Uint8ClampedArray(msg.size * msg.size * 4);
    const col = newColumn();
    const level = zone.waterLevel;
    const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    const colors = BIOMES.map((b) => rgb(BIOME_COLORS[b]));
    for (let y = 0; y < msg.size; y++)
      for (let x = 0; x < msg.size; x++) {
        // Image row 0 is north (max z)
        zone.column(msg.minX + x * msg.scale, msg.minZ + (msg.size - 1 - y) * msg.scale, col);
        let [r, g, b] = colors[col.biome];
        if (col.tree > 0) [r, g, b] = [r * 0.7, g * 0.8, b * 0.7];
        else if (level !== null && col.h < level) {
          const depth = Math.min(1, (level - col.h) / 12);
          [r, g, b] = [r * (1 - depth * 0.5), g * (1 - depth * 0.4), b * (1 - depth * 0.2)];
        } else {
          const shade = 0.85 + Math.min(0.3, (col.h - 18) / 80);
          [r, g, b] = [r * shade, g * shade, b * shade];
        }
        if (zone.ceiling !== null && col.h > 20) [r, g, b] = [40, 36, 46];
        const k = (y * msg.size + x) * 4;
        px[k] = r;
        px[k + 1] = g;
        px[k + 2] = b;
        px[k + 3] = 255;
      }
    ctx.postMessage({ type: "map", id: msg.id, pixels: px, size: msg.size }, [px.buffer]);
  }
};
