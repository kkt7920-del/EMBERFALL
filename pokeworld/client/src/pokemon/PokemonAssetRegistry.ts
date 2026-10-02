import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { ContentDB } from "@shared/data/contentDb";
import type { PokemonAnimSlot, SpeciesDef } from "@shared/types/content";
import { type BedrockAnimation, type BedrockModel, buildBedrockModel, parseAnimations, parseGeometry } from "./bedrock";

/** Status shown for a species whose model files are not available. */
export const MISSING_POKEMON_ASSET = "MISSING_POKEMON_ASSET";

export type AssetStatus = "ready" | "loading" | "missing" | "error";

type FileRef = string | Blob;

/** Where a model's files come from and how to read them. */
export interface AssetEntry {
  modelId: string;
  format: "bedrock" | "gltf";
  source: "bundled" | "imported";
  geometry?: FileRef;
  texture?: FileRef;
  animations: FileRef[];
  /** .glb / .gltf (single-file) */
  model?: FileRef;
  cry?: FileRef;
  /** Extra scale on top of the species baseScale. */
  scale: number;
  /** Per-slot animation names overriding the species defaults. */
  animationMap?: Partial<Record<PokemonAnimSlot, string>>;
  importedAt?: number;
}

export type LoadedModel =
  | { kind: "bedrock"; model: BedrockModel; animations: Map<string, BedrockAnimation>; material: StandardMaterial; scale: number; entry: AssetEntry }
  | { kind: "gltf"; container: AssetContainer; scale: number; height: number; entry: AssetEntry };

interface ManifestModel {
  format?: "bedrock" | "gltf";
  geometry?: string;
  texture?: string;
  animations?: string | string[];
  model?: string;
  cry?: string;
  scale?: number;
  animationMap?: Partial<Record<PokemonAnimSlot, string>>;
}

/** Bundled manifest and file URLs (Vite resolves these at build time; empty until files are added). */
const manifests = import.meta.glob("../../../content/pokemon/assets.json", { eager: true, import: "default" }) as Record<string, { models?: Record<string, ManifestModel> }>;
const fileUrls = import.meta.glob("../../../content/pokemon/{models,textures,animations,cries}/**/*.{json,png,glb,gltf,ogg,mp3,wav}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const DB_NAME = "pokeworld-assets";
const STORE = "models";

interface StoredModel {
  modelId: string;
  format: "bedrock" | "gltf";
  files: { role: "geometry" | "texture" | "animations" | "model" | "cry"; name: string; data: Blob }[];
  scale?: number;
  importedAt: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "modelId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readText(f: FileRef): Promise<string> {
  if (typeof f === "string") return (await fetch(f)).text();
  return f.text();
}

function urlOf(f: FileRef): { url: string; revoke: () => void } {
  if (typeof f === "string") return { url: f, revoke: () => {} };
  const url = URL.createObjectURL(f);
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/**
 * Resolves Pokémon species to model files the user is allowed to use.
 *
 * Two sources, same format:
 *  1. bundled: content/pokemon/assets.json + files in content/pokemon/{models,textures,animations,cries}
 *  2. imported in-game ("포켓몬 모델" panel): stored in this browser's IndexedDB
 *
 * Formats: Bedrock entity geometry (.geo.json) + texture (.png) + optional
 * animations (.animation.json), or glTF binary (.glb). Nothing is fetched
 * from the internet; species without files report MISSING_POKEMON_ASSET and
 * are drawn as a clearly labelled missing-asset marker, never as a stand-in creature.
 */
export class PokemonAssetRegistry {
  private readonly entries = new Map<string, AssetEntry>();
  private readonly loaded = new Map<string, Promise<LoadedModel>>();
  private readonly errors = new Map<string, string>();
  private readonly ready = new Set<string>();
  /** Fired when a model finishes loading or an import changes the set. */
  onChange: (modelId: string) => void = () => {};

  constructor(private readonly db: ContentDB) {
    for (const m of Object.values(manifests)) {
      for (const [modelId, def] of Object.entries(m.models ?? {})) {
        const entry = this.fromManifest(modelId, def);
        if (entry) this.entries.set(modelId, entry);
      }
    }
  }

  private fromManifest(modelId: string, d: ManifestModel): AssetEntry | null {
    const resolve = (p?: string) => {
      if (!p) return undefined;
      const key = Object.keys(fileUrls).find((k) => k.endsWith(`/content/pokemon/${p}`) || k.endsWith(`/${p}`));
      return key ? fileUrls[key] : undefined;
    };
    const anims = (Array.isArray(d.animations) ? d.animations : d.animations ? [d.animations] : []).map(resolve).filter((x): x is string => !!x);
    const format = d.format ?? (d.model ? "gltf" : "bedrock");
    const entry: AssetEntry = {
      modelId,
      format,
      source: "bundled",
      geometry: resolve(d.geometry),
      texture: resolve(d.texture),
      animations: anims,
      model: resolve(d.model),
      cry: resolve(d.cry),
      scale: d.scale ?? 1,
      animationMap: d.animationMap,
    };
    if (format === "bedrock" && (!entry.geometry || !entry.texture)) {
      this.errors.set(modelId, "assets.json의 geometry/texture 파일을 찾을 수 없음");
      return null;
    }
    if (format === "gltf" && !entry.model) {
      this.errors.set(modelId, "assets.json의 model 파일을 찾을 수 없음");
      return null;
    }
    return entry;
  }

  /** Loads models the user imported earlier in this browser. */
  async init(): Promise<void> {
    const idb = await openDb();
    if (!idb) return;
    const all = await new Promise<StoredModel[]>((resolve) => {
      try {
        const req = idb.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result as StoredModel[]);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    for (const s of all) this.entries.set(s.modelId, this.fromStored(s));
    idb.close();
  }

  private fromStored(s: StoredModel): AssetEntry {
    const pick = (role: StoredModel["files"][number]["role"]) => s.files.find((f) => f.role === role)?.data;
    return {
      modelId: s.modelId,
      format: s.format,
      source: "imported",
      geometry: pick("geometry"),
      texture: pick("texture"),
      animations: s.files.filter((f) => f.role === "animations").map((f) => f.data),
      model: pick("model"),
      cry: pick("cry"),
      scale: s.scale ?? 1,
      importedAt: s.importedAt,
    };
  }

  status(modelId: string): AssetStatus {
    if (this.errors.has(modelId) && !this.entries.has(modelId)) return "error";
    if (!this.entries.has(modelId)) return "missing";
    if (this.errors.has(modelId)) return "error";
    if (this.ready.has(modelId)) return "ready";
    return "loading";
  }

  statusOf(species: SpeciesDef): AssetStatus {
    return this.status(species.modelId);
  }

  error(modelId: string): string | undefined {
    return this.errors.get(modelId);
  }

  entry(modelId: string): AssetEntry | undefined {
    return this.entries.get(modelId);
  }

  /** Species that have no usable model (MISSING_POKEMON_ASSET). */
  missing(): SpeciesDef[] {
    return [...this.db.species.values()].filter((s) => !this.entries.has(s.modelId)).sort((a, b) => a.dexNumber - b.dexNumber);
  }

  report(): { total: number; available: number; missing: number } {
    const total = this.db.species.size;
    const missing = this.missing().length;
    return { total, available: total - missing, missing };
  }

  hasModel(modelId: string): boolean {
    return this.entries.has(modelId);
  }

  /** Loads (once) and returns the model for a species' modelId. */
  load(modelId: string, scene: Scene): Promise<LoadedModel> {
    let p = this.loaded.get(modelId);
    if (p) return p;
    const entry = this.entries.get(modelId);
    if (!entry) return Promise.reject(new Error(MISSING_POKEMON_ASSET));
    p = this.loadEntry(entry, scene).then(
      (m) => {
        this.ready.add(modelId);
        this.errors.delete(modelId);
        this.onChange(modelId);
        return m;
      },
      (e: Error) => {
        this.errors.set(modelId, e.message);
        this.onChange(modelId);
        throw e;
      },
    );
    this.loaded.set(modelId, p);
    return p;
  }

  private async loadEntry(entry: AssetEntry, scene: Scene): Promise<LoadedModel> {
    if (entry.format === "gltf") {
      // The glTF loader is large: only fetched when a .glb model is actually used
      await import("@babylonjs/loaders/glTF");
      const { SceneLoader } = await import("@babylonjs/core/Loading/sceneLoader");
      const { url, revoke } = urlOf(entry.model!);
      try {
        const container = await SceneLoader.LoadAssetContainerAsync("", url, scene, undefined, ".glb");
        let minY = Infinity;
        let maxY = -Infinity;
        for (const m of container.meshes) {
          m.computeWorldMatrix(true);
          const b = m.getBoundingInfo?.().boundingBox;
          if (!b) continue;
          minY = Math.min(minY, b.minimumWorld.y);
          maxY = Math.max(maxY, b.maximumWorld.y);
        }
        return { kind: "gltf", container, scale: entry.scale, height: Number.isFinite(maxY) ? maxY - minY : 1, entry };
      } finally {
        revoke();
      }
    }
    const geo = parseGeometry(JSON.parse(await readText(entry.geometry!)));
    const { url, revoke } = urlOf(entry.texture!);
    const texture = await new Promise<Texture>((resolve, reject) => {
      const t = new Texture(url, scene, true, false, Texture.NEAREST_SAMPLINGMODE, () => resolve(t), (msg) => reject(new Error(msg ?? "texture load failed")));
    });
    revoke();
    texture.hasAlpha = true;
    const material = new StandardMaterial(`pk_${entry.modelId}`, scene);
    material.diffuseTexture = texture;
    material.specularColor = new Color3(0.06, 0.06, 0.06);
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = false;
    material.transparencyMode = 1; // alpha test: crisp cut-outs (fur, fins)
    material.alphaCutOff = 0.4;
    const model = buildBedrockModel(geo, material, scene, entry.modelId);
    const animations = new Map<string, BedrockAnimation>();
    for (const f of entry.animations) for (const [k, v] of parseAnimations(JSON.parse(await readText(f)))) animations.set(k, v);
    return { kind: "bedrock", model, animations, material, scale: entry.scale, entry };
  }

  /**
   * Imports model files for a species from the player's device and keeps
   * them in this browser. Accepts .geo.json + .png (+ .animation.json, + cry)
   * or a .glb. Validates by parsing before saving.
   */
  async importFiles(modelId: string, files: File[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const lower = (f: File) => f.name.toLowerCase();
    const glb = files.find((f) => lower(f).endsWith(".glb") || lower(f).endsWith(".gltf"));
    const geo = files.find((f) => lower(f).endsWith(".geo.json") || (lower(f).endsWith(".json") && !lower(f).includes("anim")));
    const tex = files.find((f) => lower(f).endsWith(".png"));
    const anims = files.filter((f) => lower(f).endsWith(".animation.json") || (lower(f).endsWith(".json") && lower(f).includes("anim")));
    const cry = files.find((f) => /\.(ogg|mp3|wav)$/.test(lower(f)));
    const stored: StoredModel = { modelId, format: glb ? "gltf" : "bedrock", files: [], importedAt: Date.now() };
    if (glb) stored.files.push({ role: "model", name: glb.name, data: glb });
    else {
      if (!geo || !tex) return { ok: false, error: "Bedrock 모델은 .geo.json 과 .png 가 모두 필요합니다 (또는 .glb 1개)." };
      try {
        const g = parseGeometry(JSON.parse(await geo.text()));
        if (!g.bones.length) return { ok: false, error: "geometry에 bone이 없습니다." };
      } catch (e) {
        return { ok: false, error: `geometry를 읽을 수 없습니다: ${(e as Error).message}` };
      }
      for (const a of anims) {
        try {
          parseAnimations(JSON.parse(await a.text()));
        } catch (e) {
          return { ok: false, error: `${a.name}: 애니메이션을 읽을 수 없습니다 (${(e as Error).message})` };
        }
      }
      stored.files.push({ role: "geometry", name: geo.name, data: geo }, { role: "texture", name: tex.name, data: tex });
      for (const a of anims) stored.files.push({ role: "animations", name: a.name, data: a });
    }
    if (cry) stored.files.push({ role: "cry", name: cry.name, data: cry });

    const idb = await openDb();
    if (idb) {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(stored);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      idb.close();
    }
    this.entries.set(modelId, this.fromStored(stored));
    this.loaded.delete(modelId);
    this.ready.delete(modelId);
    this.errors.delete(modelId);
    this.onChange(modelId);
    return { ok: true };
  }

  async removeImport(modelId: string): Promise<void> {
    const idb = await openDb();
    if (idb) {
      await new Promise<void>((resolve) => {
        const tx = idb.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(modelId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
      idb.close();
    }
    if (this.entries.get(modelId)?.source === "imported") this.entries.delete(modelId);
    this.loaded.delete(modelId);
    this.ready.delete(modelId);
    this.errors.delete(modelId);
    this.onChange(modelId);
  }

  /** Cry sound file URL, if provided. */
  cryUrl(modelId: string): string | null {
    const c = this.entries.get(modelId)?.cry;
    if (!c) return null;
    return typeof c === "string" ? c : URL.createObjectURL(c);
  }
}
