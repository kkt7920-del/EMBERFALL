import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Scene } from "@babylonjs/core/scene";
import { CHUNK_SIZE } from "@shared/config/constants";
import type { QualitySettings } from "@shared/config/quality";
import type { RegionDef } from "@shared/types/content";
import { chunkKey, type VoxelWorld } from "@shared/world/voxelWorld";
import type { TerrainMaterials } from "../terrain/TerrainMaterial";
import type { WorkerReply, WorkerRequest } from "../terrain/chunkWorker";
import type { ChunkMeshData, LayerData } from "../terrain/voxelMesher";

const LOD_TILE = 128;
const LOD_STEP = 4;
const APPLY_BUDGET_MS = 6;

interface Slot {
  key: number;
  x: number;
  z: number;
  meshes: Mesh[];
  flora: Mesh | null;
  pending: number | null;
  built: boolean;
}

/**
 * Streams the voxel world around the player.
 *  - near: (2r+1)^2 full 32 m voxel chunks (greedy-meshed with AO and light)
 *  - far:  128 m LOD tiles sampled every 4 blocks, out to the horizon
 * Meshing runs in a pool of Web Workers; finished meshes are applied within a
 * per-frame time budget. The far LOD is not drawn over the square of full
 * chunks that is completely loaded, so the hand-over never shows holes or
 * double geometry. Nothing outside these rings exists in memory.
 */
export class ChunkManager {
  private readonly workers: Worker[] = [];
  private readonly busy: number[] = [];
  private readonly near = new Map<number, Slot>();
  private readonly far = new Map<number, Slot>();
  private readonly results: { reply: Extract<WorkerReply, { type: "chunk" }>; worker: number }[] = [];
  private readonly requests = new Map<number, { kind: "near" | "far"; key: number }>();
  private readonly mapRequests = new Map<number, (img: ImageData) => void>();
  private nextId = 1;
  private center = { cx: Number.NaN, cz: Number.NaN };
  /** Centre of the last fully loaded near square (LOD hole). */
  private ready: { cx: number; cz: number } | null = null;
  shadows: ShadowGenerator | null = null;
  castTerrainShadows = false;
  /** Fired once every near chunk around the player has a mesh. */
  onReady: (() => void) | null = null;
  /** Worker build times (ms), for diagnostics. */
  readonly buildTimes: number[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly mats: TerrainMaterials,
    region: RegionDef,
    private settings: QualitySettings,
    private readonly voxels: VoxelWorld,
  ) {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(3, cores - 1));
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL("../terrain/chunkWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<WorkerReply>) => this.onReply(ev.data, i);
      w.postMessage({ type: "init", region } satisfies WorkerRequest);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  private onReply(msg: WorkerReply, worker: number): void {
    if (msg.type === "chunk") {
      this.busy[worker]--;
      this.results.push({ reply: msg, worker });
    } else if (msg.type === "map") {
      this.busy[worker]--;
      const cb = this.mapRequests.get(msg.id);
      this.mapRequests.delete(msg.id);
      cb?.(new ImageData(new Uint8ClampedArray(msg.pixels), msg.size, msg.size));
    }
  }

  private idleWorker(): number {
    let best = -1;
    for (let i = 0; i < this.workers.length; i++) if (this.busy[i] < 2 && (best < 0 || this.busy[i] < this.busy[best])) best = i;
    return best;
  }

  private post(worker: number, msg: WorkerRequest): void {
    this.busy[worker]++;
    this.workers[worker].postMessage(msg);
  }

  setSettings(s: QualitySettings): void {
    this.settings = s;
    this.center = { cx: Number.NaN, cz: Number.NaN };
  }

  /** Drops every mesh (e.g. after a quality change). */
  reset(): void {
    for (const s of this.near.values()) this.disposeSlot(s);
    for (const s of this.far.values()) this.disposeSlot(s);
    this.near.clear();
    this.far.clear();
    this.results.length = 0;
    this.requests.clear();
    this.ready = null;
    this.center = { cx: Number.NaN, cz: Number.NaN };
    this.mats.uniforms.hole = [0, 0, 0, 0];
  }

  get loadedCount(): number {
    let n = 0;
    for (const s of this.near.values()) if (s.built) n++;
    return n;
  }

  get chunkCount(): number {
    return this.near.size;
  }

  get farCount(): number {
    let n = 0;
    for (const s of this.far.values()) if (s.meshes.length) n++;
    return n;
  }

  /** Whether all near chunks around the current centre are built. */
  get nearReady(): boolean {
    return this.ready !== null && this.ready.cx === this.center.cx && this.ready.cz === this.center.cz;
  }

  update(x: number, z: number, camDirX = 0, camDirZ = 1): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const r = this.settings.chunkRadius;
    if (pcx !== this.center.cx || pcz !== this.center.cz) {
      this.center = { cx: pcx, cz: pcz };
      // Unload near chunks beyond r+1 (unless they still form the drawn square)
      for (const [key, s] of this.near) {
        const ring = Math.max(Math.abs(s.x - pcx), Math.abs(s.z - pcz));
        const inReady = this.ready && Math.max(Math.abs(s.x - this.ready.cx), Math.abs(s.z - this.ready.cz)) <= r;
        if (ring > r + 1 && !inReady) {
          this.disposeSlot(s);
          this.near.delete(key);
        }
      }
      const ptx = Math.floor(x / LOD_TILE);
      const ptz = Math.floor(z / LOD_TILE);
      const lr = this.settings.lodTiles;
      for (const [key, s] of this.far) {
        if (Math.max(Math.abs(s.x - ptx), Math.abs(s.z - ptz)) > lr + 1) {
          this.disposeSlot(s);
          this.far.delete(key);
        }
      }
      const pinned = new Set<number>();
      for (let dz = -r - 1; dz <= r + 1; dz++) for (let dx = -r - 1; dx <= r + 1; dx++) pinned.add(chunkKey(pcx + dx, pcz + dz));
      this.voxels.pin(pinned);
    }

    // Requests: near chunks first (nearest, then in front of the camera), then far tiles
    const wantNear: { cx: number; cz: number; score: number }[] = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const key = chunkKey(pcx + dx, pcz + dz);
        const s = this.near.get(key);
        if (s && (s.pending !== null || s.built)) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const facing = (dx * camDirX + dz * camDirZ) / Math.max(1, Math.hypot(dx, dz));
        wantNear.push({ cx: pcx + dx, cz: pcz + dz, score: ring * 2 - facing });
      }
    wantNear.sort((a, b) => a.score - b.score);
    for (const w of wantNear) {
      const worker = this.idleWorker();
      if (worker < 0) break;
      const key = chunkKey(w.cx, w.cz);
      let s = this.near.get(key);
      if (!s) {
        s = { key, x: w.cx, z: w.cz, meshes: [], flora: null, pending: null, built: false };
        this.near.set(key, s);
      }
      const id = this.nextId++;
      s.pending = id;
      this.requests.set(id, { kind: "near", key });
      this.post(worker, { type: "build", id, cx: w.cx, cz: w.cz, flora: this.settings.vegetationRadius > 0 });
    }
    if (wantNear.length === 0 || this.idleWorker() >= 0) {
      const ptx = Math.floor(x / LOD_TILE);
      const ptz = Math.floor(z / LOD_TILE);
      const lr = this.settings.lodTiles;
      const wantFar: { tx: number; tz: number; d: number }[] = [];
      for (let dz = -lr; dz <= lr; dz++)
        for (let dx = -lr; dx <= lr; dx++) {
          const key = chunkKey(ptx + dx, ptz + dz);
          if (this.far.has(key)) continue;
          wantFar.push({ tx: ptx + dx, tz: ptz + dz, d: Math.hypot(dx, dz) });
        }
      wantFar.sort((a, b) => a.d - b.d);
      for (const w of wantFar) {
        if (this.ready === null && wantNear.length > 0) break;
        const worker = this.idleWorker();
        if (worker < 0) break;
        const key = chunkKey(w.tx, w.tz);
        const id = this.nextId++;
        this.far.set(key, { key, x: w.tx, z: w.tz, meshes: [], flora: null, pending: id, built: false });
        this.requests.set(id, { kind: "far", key });
        this.post(worker, { type: "lod", id, tx: w.tx, tz: w.tz, size: LOD_TILE, step: LOD_STEP });
      }
    }

    // Apply finished meshes within a time budget
    const start = performance.now();
    while (this.results.length && performance.now() - start < APPLY_BUDGET_MS) {
      const { reply } = this.results.shift()!;
      const req = this.requests.get(reply.id);
      this.requests.delete(reply.id);
      if (!req) continue;
      this.buildTimes.push(reply.ms);
      if (this.buildTimes.length > 60) this.buildTimes.shift();
      if (req.kind === "near") {
        const s = this.near.get(req.key);
        if (reply.voxels) this.voxels.put({ cx: reply.mesh.cx, cz: reply.mesh.cz, ...reply.voxels });
        if (!s || s.pending !== reply.id) continue;
        s.pending = null;
        this.disposeSlot(s);
        this.buildNear(s, reply.mesh);
        s.built = true;
      } else {
        const s = this.far.get(req.key);
        if (!s || s.pending !== reply.id) continue;
        s.pending = null;
        this.disposeSlot(s);
        this.buildFar(s, reply.mesh);
        s.built = true;
      }
    }

    // Hand-over: once the full square around the centre is built, cut the LOD hole there
    if (!this.nearReady) {
      let all = true;
      for (let dz = -r; dz <= r && all; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const s = this.near.get(chunkKey(pcx + dx, pcz + dz));
          if (!s || !s.built) {
            all = false;
            break;
          }
        }
      if (all) {
        this.ready = { cx: pcx, cz: pcz };
        // The old square (kept while this one built, e.g. after a teleport) can go now
        for (const [key, s] of this.near) {
          if (Math.max(Math.abs(s.x - pcx), Math.abs(s.z - pcz)) > r + 1) {
            this.disposeSlot(s);
            this.near.delete(key);
          }
        }
        this.mats.uniforms.hole = [(pcx - r) * CHUNK_SIZE, (pcz - r) * CHUNK_SIZE, (pcx + r + 1) * CHUNK_SIZE, (pcz + r + 1) * CHUNK_SIZE];
        if (this.onReady) {
          const cb = this.onReady;
          this.onReady = null;
          cb();
        }
      }
    }
    // Only chunks of the drawn square are visible; flora only close by
    const rd = this.ready;
    const veg = this.settings.vegetationRadius;
    for (const s of this.near.values()) {
      const inSquare = rd !== null && Math.max(Math.abs(s.x - rd.cx), Math.abs(s.z - rd.cz)) <= r;
      for (const m of s.meshes) if (m.isEnabled() !== inSquare) m.setEnabled(inSquare);
      if (s.flora) {
        const show = inSquare && Math.max(Math.abs(s.x - pcx), Math.abs(s.z - pcz)) <= veg;
        if (s.flora.isEnabled() !== show) s.flora.setEnabled(show);
      }
    }
  }

  private makeMesh(name: string, d: LayerData, material: Material, x: number, z: number): Mesh {
    const m = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = d.positions;
    vd.normals = d.normals;
    vd.colors = d.colors;
    vd.indices = d.indices;
    vd.applyToMesh(m, false);
    m.setVerticesData("atlasData", d.atlas, false, 3);
    m.setVerticesData("lightData", d.light, false, 2);
    m.material = material;
    m.position.set(x, 0, z);
    m.isPickable = false;
    m.receiveShadows = this.settings.shadows !== "off";
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.setEnabled(false);
    return m;
  }

  private buildNear(s: Slot, d: ChunkMeshData): void {
    const ox = d.cx * CHUNK_SIZE;
    const oz = d.cz * CHUNK_SIZE;
    if (d.opaque) {
      const m = this.makeMesh(`chunk_${d.cx}_${d.cz}`, d.opaque, this.mats.terrain, ox, oz);
      if (this.shadows && this.castTerrainShadows) this.shadows.addShadowCaster(m, false);
      s.meshes.push(m);
    }
    if (d.water) {
      const m = this.makeMesh(`water_${d.cx}_${d.cz}`, d.water, this.mats.water, ox, oz);
      m.alphaIndex = 10;
      s.meshes.push(m);
    }
    if (d.flora) s.flora = this.makeMesh(`flora_${d.cx}_${d.cz}`, d.flora, this.mats.flora, ox, oz);
  }

  private buildFar(s: Slot, d: ChunkMeshData): void {
    const ox = d.cx * LOD_TILE;
    const oz = d.cz * LOD_TILE;
    if (d.opaque) {
      const m = this.makeMesh(`lod_${d.cx}_${d.cz}`, d.opaque, this.mats.lod, ox, oz);
      m.receiveShadows = false;
      m.setEnabled(true);
      s.meshes.push(m);
    }
    if (d.water) {
      const m = this.makeMesh(`lodw_${d.cx}_${d.cz}`, d.water, this.mats.lodWater, ox, oz);
      m.receiveShadows = false;
      m.alphaIndex = 9;
      m.setEnabled(true);
      s.meshes.push(m);
    }
  }

  private disposeSlot(s: Slot): void {
    for (const m of s.meshes) {
      this.shadows?.removeShadowCaster(m, false);
      m.dispose(false, false);
    }
    s.flora?.dispose(false, false);
    s.meshes = [];
    s.flora = null;
  }

  /** Renders a top-down map in a worker. */
  requestMap(minX: number, minZ: number, size: number, scale: number): Promise<ImageData> {
    const id = this.nextId++;
    const worker = (id % this.workers.length) | 0;
    return new Promise((resolve) => {
      this.mapRequests.set(id, resolve);
      this.post(worker, { type: "map", id, minX, minZ, size, scale });
    });
  }

  /** Number of drawn terrain meshes (diagnostics). */
  drawnMeshes(): number {
    let n = 0;
    for (const s of [...this.near.values(), ...this.far.values()]) {
      for (const m of s.meshes) if (m.isEnabled()) n++;
      if (s.flora?.isEnabled()) n++;
    }
    return n;
  }

  dispose(): void {
    this.reset();
    for (const w of this.workers) w.terminate();
  }
}
