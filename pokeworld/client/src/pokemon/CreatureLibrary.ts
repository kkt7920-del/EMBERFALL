import { Color3 } from "@babylonjs/core/Maths/math.color";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { ContentDB } from "@shared/data/contentDb";
import type { AnimationProfileDef, ModelTemplateDef, PartRole, SpeciesDef } from "@shared/types/content";
import type { CreatureAnim } from "@shared/types/game";
import { coloredBox } from "../engine/meshUtil";

const HIDDEN_Y = -5000;

/**
 * Builds creature models from content/models templates and species colours.
 * Every (species, part) gets one hidden source mesh; each creature on screen
 * is a set of instances, so 30 of the same species cost one draw call per part.
 * Views are pooled per species and reused across spawns.
 */
export class CreatureLibrary {
  private readonly sources = new Map<string, Map<string, Mesh>>();
  private readonly pools = new Map<string, CreatureView[]>();
  readonly material: StandardMaterial;
  private readonly shadowSource: Mesh;

  constructor(
    private readonly scene: Scene,
    private readonly db: ContentDB,
  ) {
    this.material = new StandardMaterial("creatureMat", scene);
    this.material.specularColor = new Color3(0.08, 0.08, 0.08);

    const tex = new DynamicTexture("blobShadow", { width: 64, height: 64 }, scene, false);
    const g = tex.getContext() as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grad.addColorStop(0, "rgba(0,0,0,0.55)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    tex.hasAlpha = true;
    tex.update();
    const shadowMat = new StandardMaterial("blobShadowMat", scene);
    shadowMat.diffuseTexture = tex;
    shadowMat.useAlphaFromDiffuseTexture = true;
    shadowMat.disableLighting = true;
    shadowMat.emissiveColor = Color3.Black();
    shadowMat.zOffset = -2;
    this.shadowSource = CreatePlane("blobShadowSrc", { size: 1 }, scene);
    this.shadowSource.rotation.x = Math.PI / 2;
    this.shadowSource.bakeCurrentTransformIntoVertices();
    this.shadowSource.material = shadowMat;
    this.shadowSource.position.y = HIDDEN_Y;
    this.shadowSource.isPickable = false;
  }

  private partSources(species: SpeciesDef, template: ModelTemplateDef): Map<string, Mesh> {
    let map = this.sources.get(species.id);
    if (map) return map;
    map = new Map();
    const colors = species.model.colors;
    for (const part of template.parts) {
      const hex =
        part.color === "primary"
          ? colors.primary
          : part.color === "secondary"
            ? colors.secondary
            : part.color === "accent"
              ? colors.accent
              : part.color === "eye"
                ? (colors.eye ?? "#1d1d24")
                : part.color;
      const m = coloredBox(`src_${species.id}_${part.name}`, part.size, hex, this.scene);
      m.material = this.material;
      m.position.y = HIDDEN_Y;
      map.set(part.name, m);
    }
    this.sources.set(species.id, map);
    return map;
  }

  acquire(speciesId: string): CreatureView {
    const pool = this.pools.get(speciesId);
    const reused = pool?.pop();
    if (reused) {
      reused.reset();
      reused.root.setEnabled(true);
      return reused;
    }
    const species = this.db.species.get(speciesId);
    if (!species) throw new Error(`unknown species ${speciesId}`);
    const template = this.db.models.get(species.model.template)!;
    const profile = this.db.animations.get(template.rig)!;
    return new CreatureView(this.scene, species, template, profile, this.partSources(species, template), this.shadowSource);
  }

  release(view: CreatureView): void {
    view.root.setEnabled(false);
    view.shadow.setEnabled(false);
    let pool = this.pools.get(view.species.id);
    if (!pool) this.pools.set(view.species.id, (pool = []));
    pool.push(view);
  }
}

const LEG_SIGN: Partial<Record<PartRole, number>> = { legFL: 1, legBR: 1, legFR: -1, legBL: -1, legL: 1, legR: -1, armL: -1, armR: 1 };

export class CreatureView {
  readonly root: TransformNode;
  /** Child of root that carries bob/lunge/faint so root stays at the world position. */
  private readonly rig: TransformNode;
  private readonly pivots: { role: PartRole; node: TransformNode; base: { x: number; y: number; z: number } }[] = [];
  private readonly instances: InstancedMesh[] = [];
  readonly shadow: InstancedMesh;
  anim: CreatureAnim = "idle";
  private t = Math.random() * 10;
  private attackT = -1;
  private faintT = -1;
  private hitT = -1;
  readonly scale: number;

  constructor(
    scene: Scene,
    readonly species: SpeciesDef,
    readonly template: ModelTemplateDef,
    private readonly profile: AnimationProfileDef,
    sources: Map<string, Mesh>,
    shadowSource: Mesh,
  ) {
    this.scale = species.model.scale ?? 1;
    this.root = new TransformNode(`creature_${species.id}`, scene);
    this.rig = new TransformNode(`rig_${species.id}`, scene);
    this.rig.parent = this.root;
    this.rig.scaling.setAll(this.scale);

    const nodes = new Map<string, TransformNode>();
    for (const part of template.parts) {
      const pivot = new TransformNode(`pv_${part.name}`, scene);
      pivot.parent = part.parent ? nodes.get(part.parent)! : this.rig;
      pivot.position.set(part.pos[0], part.pos[1], part.pos[2]);
      nodes.set(part.name, pivot);
      const inst = sources.get(part.name)!.createInstance(`i_${part.name}`);
      inst.parent = pivot;
      inst.position.set(part.offset?.[0] ?? 0, part.offset?.[1] ?? 0, part.offset?.[2] ?? 0);
      inst.isPickable = false;
      this.instances.push(inst);
      this.pivots.push({ role: part.role, node: pivot, base: { x: part.pos[0], y: part.pos[1], z: part.pos[2] } });
    }

    this.shadow = shadowSource.createInstance(`shadow_${species.id}`);
    this.shadow.scaling.setAll(0.9 * this.scale);
    this.shadow.isPickable = false;
  }

  meshes(): InstancedMesh[] {
    return this.instances;
  }

  reset(): void {
    this.anim = "idle";
    this.attackT = -1;
    this.faintT = -1;
    this.hitT = -1;
    this.rig.position.setAll(0);
    this.rig.rotation.setAll(0);
    this.rig.scaling.setAll(this.scale);
    this.shadow.setEnabled(true);
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on);
    this.shadow.setEnabled(on);
  }

  playAttack(): void {
    this.attackT = 0;
  }

  playHit(): void {
    this.hitT = 0;
  }

  playFaint(): void {
    this.faintT = 0;
  }

  get fainted(): boolean {
    return this.faintT >= 0;
  }

  /** Height of the model's top, for name tags and capture effects. */
  get height(): number {
    return 1.1 * this.scale;
  }

  update(dt: number, groundY: number): void {
    this.t += dt;
    const p = this.profile;
    const t = this.t;
    const anim = this.anim;

    let bob = 0;
    let freq = 0;
    let swing = 0;
    let flap = 0;
    let sway = 0;
    switch (anim) {
      case "walk":
        freq = p.walk.freq;
        swing = p.walk.swing;
        bob = Math.abs(Math.sin(t * freq)) * p.walk.bob;
        break;
      case "run":
        freq = p.run.freq;
        swing = p.run.swing;
        bob = Math.abs(Math.sin(t * freq)) * p.run.bob;
        break;
      case "swim":
        freq = p.swim.freq;
        sway = Math.sin(t * freq) * p.swim.sway;
        bob = Math.sin(t * 2) * p.swim.bob;
        swing = 0.4;
        break;
      case "fly":
        flap = Math.sin(t * p.fly.flapFreq) * p.fly.flapAngle;
        bob = Math.sin(t * 2.4) * p.fly.bob;
        break;
      case "battle":
        bob = Math.abs(Math.sin(t * p.battleIdle.speed)) * p.battleIdle.bob;
        freq = p.battleIdle.speed;
        swing = 0.1;
        if (this.template.rig === "bird" || this.template.rig === "bat") flap = Math.sin(t * 7) * 0.5;
        break;
      case "sleep":
        bob = Math.sin(t) * 0.01;
        break;
      default:
        bob = Math.sin(t * p.idle.speed) * p.idle.bob;
        freq = p.idle.speed;
        swing = 0.04;
        if (this.template.rig === "bat") flap = Math.sin(t * 9) * 0.6;
    }
    if (this.template.rig === "fish") sway = Math.sin(t * (p.swim.freq * 0.8)) * p.swim.sway;

    for (const pv of this.pivots) {
      const n = pv.node;
      switch (pv.role) {
        case "legFL":
        case "legFR":
        case "legBL":
        case "legBR":
        case "legL":
        case "legR":
          n.rotation.x = anim === "fly" && this.template.rig === "bird" ? 0.9 : Math.sin(t * freq) * swing * (LEG_SIGN[pv.role] ?? 1);
          break;
        case "armL":
        case "armR":
          n.rotation.x = Math.sin(t * freq) * swing * (LEG_SIGN[pv.role] ?? 1);
          break;
        case "wingL":
          n.rotation.z = this.template.rig === "fish" ? Math.sin(t * 6) * 0.4 : flap || -0.15;
          break;
        case "wingR":
          n.rotation.z = this.template.rig === "fish" ? -Math.sin(t * 6) * 0.4 : -(flap || -0.15);
          break;
        case "tail":
          n.rotation.y = this.template.rig === "fish" ? sway * 1.4 : Math.sin(t * 3) * 0.25;
          break;
        case "head":
          n.rotation.x = anim === "battle" ? -0.08 : Math.sin(t * 0.7) * 0.05;
          break;
        default:
          break;
      }
    }

    // One-shot animations on the rig
    let lunge = 0;
    if (this.attackT >= 0) {
      this.attackT += dt;
      const k = this.attackT / p.attack.duration;
      lunge = k < 1 ? Math.sin(k * Math.PI) * p.attack.lunge : 0;
      if (k >= 1) this.attackT = -1;
    }
    let shake = 0;
    if (this.hitT >= 0) {
      this.hitT += dt;
      shake = this.hitT < 0.35 ? Math.sin(this.hitT * 60) * 0.08 : 0;
      if (this.hitT >= 0.35) this.hitT = -1;
    }
    if (this.faintT >= 0) {
      this.faintT = Math.min(p.faint.duration, this.faintT + dt);
      const k = this.faintT / p.faint.duration;
      this.rig.rotation.z = k * (Math.PI / 2);
      this.rig.position.y = -0.2 * k * this.scale;
      this.rig.scaling.setAll(this.scale * (1 - 0.15 * k));
      return;
    }
    this.rig.position.set(shake, bob * this.scale, lunge * this.scale);
    this.rig.rotation.z = sway * 0.4;

    // Blob shadow under the model
    const pos = this.root.position;
    this.shadow.position.set(pos.x, groundY + 0.06, pos.z);
    const height = Math.max(0, pos.y - groundY);
    this.shadow.scaling.setAll(Math.max(0.3, 0.9 * this.scale - height * 0.05));
  }

  dispose(): void {
    for (const i of this.instances) i.dispose();
    this.shadow.dispose();
    this.root.dispose();
  }
}
