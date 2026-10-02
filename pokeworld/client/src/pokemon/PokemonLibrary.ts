import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import "@babylonjs/core/Meshes/instancedMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { ContentDB } from "@shared/data/contentDb";
import type { SpeciesDef } from "@shared/types/content";
import { MISSING_POKEMON_ASSET, type PokemonAssetRegistry } from "./PokemonAssetRegistry";
import { type PokemonBody, PokemonView, makeBody, makeMissingBody } from "./PokemonView";

export interface AcquireOptions {
  size?: number;
  alpha?: boolean;
}

/**
 * Hands out PokemonViews for species. A species with a model gets its real
 * model (loaded on first use); one without shows the MISSING_POKEMON_ASSET
 * marker. Views are pooled per species, and every live view is upgraded in
 * place when its model finishes loading or is imported later.
 */
export class PokemonLibrary {
  private readonly pools = new Map<string, PokemonView[]>();
  private readonly live = new Set<PokemonView>();
  private readonly missingBox: Mesh;
  private readonly labels = new Map<string, Mesh>();
  private readonly labelMat = new Map<string, StandardMaterial>();
  /** Asset report printed once per species (missing models). */
  private readonly reported = new Set<string>();

  constructor(
    private readonly scene: Scene,
    private readonly db: ContentDB,
    readonly assets: PokemonAssetRegistry,
  ) {
    // Classic "missing texture" checker: unmistakably not a creature
    const tex = new DynamicTexture("missingTex", { width: 64, height: 64 }, scene, false, Texture.NEAREST_SAMPLINGMODE);
    const g = tex.getContext() as CanvasRenderingContext2D;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        g.fillStyle = (x + y) % 2 ? "#ff00dc" : "#101010";
        g.fillRect(x * 16, y * 16, 16, 16);
      }
    g.fillStyle = "#ffffff";
    g.font = "bold 28px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("?", 32, 34);
    tex.update();
    const mat = new StandardMaterial("missingMat", scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(0.35, 0.1, 0.3);
    mat.specularColor = Color3.Black();
    mat.alpha = 0.85;
    this.missingBox = CreateBox("missingBox", { size: 1 }, scene);
    this.missingBox.material = mat;
    this.missingBox.isPickable = false;
    this.missingBox.setEnabled(false);

    assets.onChange = (modelId) => this.refresh(modelId);
  }

  private label(species: SpeciesDef): Mesh {
    let m = this.labels.get(species.id);
    if (m) return m;
    const tex = new DynamicTexture(`ml_${species.id}`, { width: 512, height: 128 }, this.scene, false);
    const g = tex.getContext() as CanvasRenderingContext2D;
    g.fillStyle = "rgba(20,10,24,0.82)";
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = "#ff3cdc";
    g.lineWidth = 6;
    g.strokeRect(3, 3, 506, 122);
    g.fillStyle = "#ff8af0";
    g.font = "bold 34px monospace";
    g.textAlign = "center";
    g.fillText(MISSING_POKEMON_ASSET, 256, 52);
    g.fillStyle = "#ffffff";
    g.font = "bold 34px sans-serif";
    g.fillText(`#${String(species.dexNumber).padStart(3, "0")} ${species.name}`, 256, 100);
    tex.update();
    tex.hasAlpha = true;
    const mat = new StandardMaterial(`mlm_${species.id}`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.backFaceCulling = false;
    this.labelMat.set(species.id, mat);
    m = CreatePlane(`mlp_${species.id}`, { width: 2.2, height: 0.55 }, this.scene);
    m.material = mat;
    m.isPickable = false;
    m.setEnabled(false);
    this.labels.set(species.id, m);
    return m;
  }

  private bodyFor(species: SpeciesDef, name: string): { body: PokemonBody; scale: number } {
    const loaded = this.assets.status(species.modelId) === "ready" ? this.syncLoaded.get(species.modelId) : undefined;
    if (loaded) return { body: makeBody(this.scene, loaded, species, name), scale: loaded.scale };
    if (this.assets.hasModel(species.modelId)) this.startLoad(species);
    else if (!this.reported.has(species.id)) {
      this.reported.add(species.id);
      console.info(`[assets] ${MISSING_POKEMON_ASSET}: #${species.dexNumber} ${species.name} (modelId "${species.modelId}")`);
    }
    return { body: makeMissingBody(this.scene, this.missingBox, this.label(species), species, name), scale: 1 };
  }

  private readonly syncLoaded = new Map<string, import("./PokemonAssetRegistry").LoadedModel>();
  private readonly loading = new Set<string>();

  private startLoad(species: SpeciesDef): void {
    if (this.loading.has(species.modelId)) return;
    this.loading.add(species.modelId);
    this.assets
      .load(species.modelId, this.scene)
      .then((m) => {
        this.syncLoaded.set(species.modelId, m);
        this.refresh(species.modelId);
      })
      .catch((e: Error) => console.warn(`[assets] ${species.name}: ${e.message}`))
      .finally(() => this.loading.delete(species.modelId));
  }

  /** Swaps bodies of live and pooled views after a model change. */
  private refresh(modelId: string): void {
    const loaded = this.syncLoaded.get(modelId);
    if (!loaded && this.assets.hasModel(modelId) && this.assets.status(modelId) !== "error") {
      const sp = [...this.db.species.values()].find((s) => s.modelId === modelId);
      if (sp) this.startLoad(sp);
      return;
    }
    if (!this.assets.hasModel(modelId)) this.syncLoaded.delete(modelId);
    const all = [...this.live, ...[...this.pools.values()].flat()];
    for (const v of all) {
      if (v.species.modelId !== modelId) continue;
      const next = this.bodyFor(v.species, `pk_${v.species.id}_${v.id}`);
      v.setBody(next.body, next.scale);
      v.status = this.assets.status(modelId);
    }
  }

  acquire(speciesId: string, opts: AcquireOptions = {}): PokemonView {
    const species = this.db.species.get(speciesId);
    if (!species) throw new Error(`unknown species ${speciesId}`);
    const pool = this.pools.get(speciesId);
    let view = pool?.pop();
    if (view) {
      view.reset();
      view.root.setEnabled(true);
    } else {
      const { body, scale } = this.bodyFor(species, `pk_${species.id}`);
      view = new PokemonView(this.scene, species, body, scale);
    }
    view.size = opts.size ?? 1;
    view.alpha = !!opts.alpha;
    view.status = this.assets.status(species.modelId);
    this.live.add(view);
    return view;
  }

  release(view: PokemonView): void {
    view.root.setEnabled(false);
    this.live.delete(view);
    let pool = this.pools.get(view.species.id);
    if (!pool) this.pools.set(view.species.id, (pool = []));
    if (pool.length < 6) pool.push(view);
    else view.dispose();
  }

  get liveCount(): number {
    return this.live.size;
  }
}
