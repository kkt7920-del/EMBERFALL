import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { Scene } from "@babylonjs/core/scene";
import { CHUNK_SIZE } from "@shared/config/constants";
import type { QualitySettings } from "@shared/config/quality";
import type { RegionDef } from "@shared/types/content";
import { Tile } from "@shared/world/blocks";
import type { ChunkMeshData } from "../terrain/mesher";
import type { WorkerRequest } from "../terrain/chunkWorker";

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  flora: boolean;
  /** LOD/flora currently being built, if any. */
  pending: { id: number; lod: number; flora: boolean } | null;
  meshes: Mesh[];
}

const MAX_IN_FLIGHT = 3;
const APPLY_BUDGET_MS = 5;

/**
 * Streams terrain chunks around the player. Only (2r+1)^2 chunks ever exist:
 * far rings use coarser LOD meshes, chunks beyond r+1 are disposed, and
 * meshing happens in a Web Worker so the frame loop never stalls on it.
 */
export class ChunkManager {
  private readonly worker: Worker;
  private readonly chunks = new Map<string, Chunk>();
  private readonly results: ChunkMeshData[] = [];
  private readonly byRequest = new Map<number, string>();
  private zone = "";
  private nextId = 1;
  private inFlight = 0;
  private center = { cx: Number.NaN, cz: Number.NaN };
  private readonly canopySource: Mesh;
  private readonly floraSource: Mesh;
  private readonly crystalSource: Mesh;
  readonly waterMaterial: StandardMaterial;
  private readonly mapRequests = new Map<number, (img: ImageData) => void>();
  shadows: ShadowGenerator | null = null;
  castTerrainShadows = false;
  /** Fired once the chunk under the player has a mesh. */
  onReady: (() => void) | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly terrainMaterial: StandardMaterial,
    region: RegionDef,
    private settings: QualitySettings,
  ) {
    this.worker = new Worker(new URL("../terrain/chunkWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev) => {
      const msg = ev.data as { type: string; id: number; data?: ChunkMeshData; pixels?: Uint8ClampedArray; size?: number };
      if (msg.type === "chunk" && msg.data) {
        this.inFlight--;
        this.results.push(msg.data);
      } else if (msg.type === "map" && msg.pixels && msg.size) {
        const cb = this.mapRequests.get(msg.id);
        this.mapRequests.delete(msg.id);
        cb?.(new ImageData(new Uint8ClampedArray(msg.pixels), msg.size, msg.size));
      }
    };
    this.post({ type: "init", region });

    this.canopySource = this.makeCanopy();
    this.floraSource = this.makeFlora();
    this.crystalSource = this.makeCrystal();

    this.waterMaterial = new StandardMaterial("water", scene);
    this.waterMaterial.diffuseColor = new Color3(0.2, 0.5, 0.85);
    this.waterMaterial.specularColor = new Color3(0.5, 0.6, 0.7);
    this.waterMaterial.specularPower = 64;
    this.waterMaterial.alpha = 0.72;
    this.waterMaterial.backFaceCulling = false;
  }

  private post(msg: WorkerRequest): void {
    this.worker.postMessage(msg);
  }

  setSettings(s: QualitySettings): void {
    this.settings = s;
    this.center = { cx: Number.NaN, cz: Number.NaN };
  }

  setZone(zone: string): void {
    if (zone === this.zone) return;
    this.zone = zone;
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.results.length = 0;
    this.byRequest.clear();
    this.center = { cx: Number.NaN, cz: Number.NaN };
  }

  get loadedCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) if (c.meshes.length) n++;
    return n;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Requests and applies chunks for a player at x/z. Call every frame. */
  update(x: number, z: number, bounds: { minX: number; minZ: number; maxX: number; maxZ: number } | null): void {
    const pcx = Math.floor(x / CHUNK_SIZE);
    const pcz = Math.floor(z / CHUNK_SIZE);
    const r = this.settings.chunkRadius;

    if (pcx !== this.center.cx || pcz !== this.center.cz) {
      this.center = { cx: pcx, cz: pcz };
      // Unload beyond r+1 (hysteresis avoids thrashing on chunk borders)
      for (const [key, c] of this.chunks) {
        if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > r + 1) {
          this.disposeChunk(c);
          this.chunks.delete(key);
        }
      }
    }

    // Desired chunks, nearest first
    const wanted: { cx: number; cz: number; ring: number }[] = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (bounds && (cx * CHUNK_SIZE >= bounds.maxX || cz * CHUNK_SIZE >= bounds.maxZ || (cx + 1) * CHUNK_SIZE <= bounds.minX || (cz + 1) * CHUNK_SIZE <= bounds.minZ))
          continue;
        wanted.push({ cx, cz, ring: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    wanted.sort((a, b) => a.ring - b.ring);

    for (const w of wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      const lod = w.ring <= 1 ? 1 : w.ring === 2 ? 2 : 4;
      const flora = w.ring <= this.settings.vegetationRadius && lod === 1;
      const key = `${w.cx},${w.cz}`;
      let c = this.chunks.get(key);
      if (!c) {
        c = { key, cx: w.cx, cz: w.cz, lod: 0, flora: false, pending: null, meshes: [] };
        this.chunks.set(key, c);
      }
      const target = c.pending ?? { lod: c.lod, flora: c.flora };
      if (target.lod === lod && target.flora === flora && (c.meshes.length || c.pending)) continue;
      const id = this.nextId++;
      c.pending = { id, lod, flora };
      this.byRequest.set(id, key);
      this.inFlight++;
      this.post({ type: "build", id, zone: this.zone, cx: w.cx, cz: w.cz, lod, flora });
    }

    // Apply finished meshes within a time budget
    const start = performance.now();
    while (this.results.length && performance.now() - start < APPLY_BUDGET_MS) {
      const data = this.results.shift()!;
      if (data.zone !== this.zone) continue;
      const c = this.chunks.get(`${data.cx},${data.cz}`);
      if (!c || !c.pending || c.pending.lod !== data.lod) continue;
      const flora = c.pending.flora;
      c.pending = null;
      this.disposeChunk(c);
      c.lod = data.lod;
      c.flora = flora;
      c.meshes = this.buildMeshes(data);
      if (c.cx === pcx && c.cz === pcz && this.onReady) {
        const cb = this.onReady;
        this.onReady = null;
        cb();
      }
    }
  }

  private buildMeshes(d: ChunkMeshData): Mesh[] {
    const scene = this.scene;
    const ox = d.cx * CHUNK_SIZE;
    const oz = d.cz * CHUNK_SIZE;
    const out: Mesh[] = [];
    const receive = this.settings.shadows !== "off";

    if (d.indices.length) {
      const m = new Mesh(`terrain_${d.cx}_${d.cz}`, scene);
      const vd = new VertexData();
      vd.positions = d.positions;
      vd.normals = d.normals;
      vd.colors = d.colors;
      vd.indices = d.indices;
      vd.applyToMesh(m, false);
      m.setVerticesData("atlasData", d.atlas, false, 3);
      m.material = this.terrainMaterial;
      m.position.set(ox, 0, oz);
      m.isPickable = false;
      m.receiveShadows = receive;
      m.freezeWorldMatrix();
      m.doNotSyncBoundingInfo = true;
      if (this.shadows && this.castTerrainShadows) this.shadows.addShadowCaster(m, false);
      out.push(m);
    }

    if (d.water) {
      const m = new Mesh(`water_${d.cx}_${d.cz}`, scene);
      const vd = new VertexData();
      vd.positions = d.water.positions;
      vd.indices = d.water.indices;
      const normals = new Float32Array(d.water.positions.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      vd.normals = normals;
      vd.applyToMesh(m, false);
      m.material = this.waterMaterial;
      m.position.set(ox, 0, oz);
      m.isPickable = false;
      m.receiveShadows = receive;
      m.freezeWorldMatrix();
      m.alphaIndex = 10;
      out.push(m);
    }

    if (d.trees.length) {
      const count = d.trees.length / 4;
      const m = this.instanceHost(this.canopySource, `canopy_${d.cx}_${d.cz}`);
      m.position.setAll(0);
      const buf = new Float32Array(count * 16);
      const mat = new Matrix();
      for (let i = 0; i < count; i++) {
        const size = d.trees[i * 4 + 3];
        Matrix.ComposeToRef(
          new Vector3(size, size * 0.85, size),
          Quaternion.Identity(),
          // Canopy sits on the trunk top, overlapping it by ~0.7 m
          new Vector3(ox + d.trees[i * 4], d.trees[i * 4 + 1] + size * 0.425 - 0.7, oz + d.trees[i * 4 + 2]),
          mat,
        );
        mat.copyToArray(buf, i * 16);
      }
      m.thinInstanceSetBuffer("matrix", buf, 16, true);
      m.thinInstanceRefreshBoundingInfo(false);
      m.receiveShadows = receive;
      m.isPickable = false;
      if (this.shadows && this.settings.shadows !== "low") this.shadows.addShadowCaster(m, false);
      out.push(m);
    }

    if (d.flora.length) {
      const count = d.flora.length / 4;
      const m = this.instanceHost(this.floraSource, `flora_${d.cx}_${d.cz}`);
      const buf = new Float32Array(count * 16);
      const colors = new Float32Array(count * 4);
      const mat = new Matrix();
      const palette = [
        [0.36, 0.66, 0.26],
        [0.85, 0.32, 0.36],
        [0.95, 0.82, 0.3],
      ];
      for (let i = 0; i < count; i++) {
        const kind = d.flora[i * 4 + 3];
        const s = kind === 0 ? 0.9 : 0.7;
        Matrix.ComposeToRef(new Vector3(s, s, s), Quaternion.RotationAxis(Vector3.Up(), i * 1.3), new Vector3(ox + d.flora[i * 4], d.flora[i * 4 + 1], oz + d.flora[i * 4 + 2]), mat);
        mat.copyToArray(buf, i * 16);
        const c = palette[kind] ?? palette[0];
        colors.set([c[0], c[1], c[2], 1], i * 4);
      }
      m.thinInstanceSetBuffer("matrix", buf, 16, true);
      m.thinInstanceSetBuffer("color", colors, 4, true);
      m.thinInstanceRefreshBoundingInfo(false);
      m.isPickable = false;
      out.push(m);
    }

    if (d.crystals.length) {
      const count = d.crystals.length / 3;
      const m = this.instanceHost(this.crystalSource, `crystal_${d.cx}_${d.cz}`);
      const buf = new Float32Array(count * 16);
      const mat = new Matrix();
      for (let i = 0; i < count; i++) {
        Matrix.ComposeToRef(
          new Vector3(0.5, 0.9, 0.5),
          Quaternion.FromEulerAngles(0.3, i, 0.2),
          new Vector3(ox + d.crystals[i * 3], d.crystals[i * 3 + 1] + 0.4, oz + d.crystals[i * 3 + 2]),
          mat,
        );
        mat.copyToArray(buf, i * 16);
      }
      m.thinInstanceSetBuffer("matrix", buf, 16, true);
      m.thinInstanceRefreshBoundingInfo(false);
      m.isPickable = false;
      out.push(m);
    }

    return out;
  }

  /**
   * A per-chunk mesh for thin instances. Thin-instance buffers live on the
   * geometry, so each chunk needs its own copy (a plain clone would share it).
   */
  private instanceHost(source: Mesh, name: string): Mesh {
    const m = source.clone(name) as Mesh;
    m.makeGeometryUnique();
    m.setEnabled(true);
    m.position.setAll(0);
    return m;
  }

  private disposeChunk(c: Chunk): void {
    for (const m of c.meshes) {
      this.shadows?.removeShadowCaster(m, false);
      m.dispose(false, false);
    }
    c.meshes = [];
  }

  private makeCanopy(): Mesh {
    const box = CreateBox("canopySource", { size: 1 }, this.scene);
    const positions = box.getVerticesData("position")!;
    const normals = box.getVerticesData("normal")!;
    const atlas = new Float32Array((positions.length / 3) * 3);
    const colors = new Float32Array((positions.length / 3) * 4);
    for (let i = 0; i < positions.length / 3; i++) {
      // Tile 3 times per face: canopies are ~3 m wide
      const nx = Math.abs(normals[i * 3]);
      const ny = Math.abs(normals[i * 3 + 1]);
      const u = nx > 0.5 ? positions[i * 3 + 2] : positions[i * 3];
      const v = ny > 0.5 ? positions[i * 3 + 2] : positions[i * 3 + 1];
      atlas[i * 3] = (u + 0.5) * 3;
      atlas[i * 3 + 1] = (v + 0.5) * 3;
      atlas[i * 3 + 2] = Tile.LEAVES;
      const shade = ny > 0.5 ? 1 : 0.8;
      colors.set([shade, shade, shade, 1], i * 4);
    }
    box.setVerticesData("atlasData", atlas, false, 3);
    box.setVerticesData("color", colors, false, 4);
    box.material = this.terrainMaterial;
    box.isPickable = false;
    box.setEnabled(false);
    return box;
  }

  private makeFlora(): Mesh {
    // A tuft of five thin blades (geometry only; colour comes per instance)
    const m = new Mesh("floraSource", this.scene);
    const pos: number[] = [];
    const nrm: number[] = [];
    const idx: number[] = [];
    const blades: [number, number, number, number][] = [
      [0, 0, 0.75, 0],
      [0.14, 0.05, 0.55, 1.1],
      [-0.13, 0.04, 0.6, 2.2],
      [0.05, -0.13, 0.5, 0.6],
      [-0.06, 0.12, 0.45, 2.8],
    ];
    for (const [bx, bz, h, a] of blades) {
      const w = 0.05;
      const dx = Math.cos(a) * w;
      const dz = Math.sin(a) * w;
      const lean = 0.08;
      const base = pos.length / 3;
      pos.push(bx - dx, 0, bz - dz, bx + dx, 0, bz + dz, bx + dx * 0.3 + lean * Math.sin(a), h, bz + dz * 0.3, bx - dx * 0.3 + lean * Math.sin(a), h, bz - dz * 0.3);
      for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.normals = nrm;
    vd.indices = idx;
    vd.applyToMesh(m);
    const mat = new StandardMaterial("flora", this.scene);
    mat.backFaceCulling = false;
    mat.specularColor = Color3.Black();
    mat.diffuseColor = Color3.White();
    m.material = mat;
    m.isPickable = false;
    m.setEnabled(false);
    return m;
  }

  private makeCrystal(): Mesh {
    const box = CreateBox("crystalSource", { size: 1 }, this.scene);
    const mat = new StandardMaterial("crystal", this.scene);
    mat.diffuseColor = new Color3(0.5, 0.85, 1);
    mat.emissiveColor = new Color3(0.35, 0.6, 0.9);
    mat.specularColor = new Color3(1, 1, 1);
    box.material = mat;
    box.isPickable = false;
    box.setEnabled(false);
    return box;
  }

  /** Renders a top-down map of a zone in the worker. */
  requestMap(zone: string, minX: number, minZ: number, size: number, scale: number): Promise<ImageData> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.mapRequests.set(id, resolve);
      this.post({ type: "map", id, zone, minX, minZ, size, scale });
    });
  }

  dispose(): void {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.worker.terminate();
  }
}
