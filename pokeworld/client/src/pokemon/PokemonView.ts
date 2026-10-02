import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Space } from "@babylonjs/core/Maths/math.axis";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { PokemonAnimSlot, SpeciesDef } from "@shared/types/content";
import type { CreatureAnim, WildMode } from "@shared/types/game";
import { type BedrockAnimation, bedrockRotation, convertOffset, type RigBone, sampleChannel } from "./bedrock";
import type { MolangContext } from "./molang";
import type { AssetStatus, LoadedModel } from "./PokemonAssetRegistry";

/** Animation slots the view asks a model for, with Cobblemon-style default names and fallbacks. */
const SLOT_NAMES: Record<string, string[]> = {
  idle: ["ground_idle", "idle", "stand"],
  walk: ["ground_walk", "walk", "move"],
  run: ["ground_run", "run", "ground_walk", "walk"],
  turn: ["ground_turn", "turn"],
  idle_water: ["water_idle", "surface_idle", "swim_idle", "ground_idle", "idle"],
  swim: ["water_swim", "surface_swim", "swim", "ground_walk", "walk"],
  turn_water: ["water_turn", "swim_turn"],
  dive: ["water_dive", "dive", "underwater_swim", "water_swim", "swim"],
  idle_air: ["air_idle", "fly_idle", "hover", "ground_idle", "idle"],
  fly: ["air_fly", "fly", "flying", "air_idle"],
  glide: ["air_glide", "glide", "air_fly", "fly"],
  turn_air: ["air_turn", "fly_turn"],
  battle_idle: ["battle_idle", "ground_idle", "idle"],
  physical: ["physical", "attack", "physical_attack"],
  special: ["special", "special_attack", "physical", "attack"],
  damage: ["recoil", "damage", "hurt", "hit"],
  recoil: ["recoil", "angry", "damage"],
  faint: ["faint", "death", "die"],
  sleep: ["sleep", "ground_sleep"],
  cry: ["cry"],
};

/** Engine slot -> species JSON slot name (species.animations overrides the first choice). */
const SPECIES_SLOT: Partial<Record<string, PokemonAnimSlot>> = {
  idle: "idle",
  walk: "walk",
  run: "run",
  swim: "swim",
  fly: "fly",
  battle_idle: "battleIdle",
  physical: "attack",
  damage: "recoil",
  recoil: "recoil",
  faint: "faint",
};

const DEG = Math.PI / 180;

/** Everything the game needs from a Pokémon on screen, whatever its asset state. */
export interface PokemonBody {
  readonly kind: "bedrock" | "gltf" | "missing";
  readonly node: TransformNode;
  /** Height at scale 1 (blocks). */
  readonly height: number;
  update(dt: number, s: AnimState): void;
  setEnergy(k: number): void;
  setEnabled(on: boolean): void;
  meshes(): AbstractMesh[];
  dispose(): void;
}

export interface AnimState {
  anim: CreatureAnim;
  mode: WildMode;
  /** Turning speed (rad/s), for turn animations and lean. */
  turnRate: number;
  /** Vertical speed (m/s), for dive/glide. */
  climb: number;
  oneShot: { slot: string; t: number; length: number } | null;
  time: number;
}

// ---------------------------------------------------------------- Bedrock body

class BedrockBody implements PokemonBody {
  readonly kind = "bedrock" as const;
  readonly node: TransformNode;
  readonly height: number;
  private readonly mesh: Mesh;
  private readonly bones: Bone[];
  private readonly rig: RigBone[];
  private readonly anims: Map<string, BedrockAnimation>;
  private readonly slotCache = new Map<string, BedrockAnimation | null>();
  private readonly ctx: MolangContext = { q: {}, v: {}, t: {} };
  private current: { anim: BedrockAnimation | null; t: number; slot: string } = { anim: null, t: 0, slot: "" };
  private previous: { anim: BedrockAnimation | null; t: number; weight: number } | null = null;
  private readonly roles: ("head" | "neck" | "tail" | "ear" | "wingL" | "wingR" | "legL" | "legR" | "armL" | "armR" | "body" | "other")[];
  private readonly mat: StandardMaterial;
  private readonly seed = Math.random() * 100;

  constructor(
    scene: Scene,
    loaded: Extract<LoadedModel, { kind: "bedrock" }>,
    private readonly species: SpeciesDef,
    name: string,
  ) {
    this.node = new TransformNode(`${name}_body`, scene);
    this.mesh = loaded.model.mesh.clone(`${name}_mesh`, this.node, true) as Mesh;
    this.mesh.skeleton = loaded.model.skeleton.clone(`${name}_skel`, `${name}_skel`);
    this.mesh.setEnabled(true);
    this.mesh.alwaysSelectAsActiveMesh = false;
    this.mat = loaded.material;
    this.bones = this.mesh.skeleton.bones;
    this.rig = loaded.model.bones;
    this.anims = loaded.animations;
    this.height = loaded.model.height;
    this.roles = this.rig.map((b) => boneRole(b.name));
    const overrides = loaded.entry.animationMap;
    if (overrides) for (const [slot, n] of Object.entries(overrides)) this.slotCache.set(slot, this.findAnim([n!]));
  }

  private findAnim(names: string[]): BedrockAnimation | null {
    for (const n of names) {
      const key = n.toLowerCase();
      for (const [k, a] of this.anims) {
        const kl = k.toLowerCase();
        if (kl === key || kl.endsWith(`.${key}`)) return a;
      }
    }
    return null;
  }

  private animFor(slot: string): BedrockAnimation | null {
    if (this.slotCache.has(slot)) return this.slotCache.get(slot)!;
    const sp = SPECIES_SLOT[slot];
    const names = [...(sp && this.species.animations[sp] ? [this.species.animations[sp]!] : []), ...(SLOT_NAMES[slot] ?? [slot])];
    const a = this.findAnim(names);
    this.slotCache.set(slot, a);
    return a;
  }

  hasClip(slot: string): boolean {
    return this.animFor(slot) !== null;
  }

  update(dt: number, s: AnimState): void {
    const slot = baseSlot(s);
    const anim = this.animFor(slot) ?? this.animFor("idle");
    if (slot !== this.current.slot) {
      this.previous = { anim: this.current.anim, t: this.current.t, weight: 1 };
      this.current = { anim, t: 0, slot };
    }
    const speed = s.anim === "run" && !this.animFor("run") ? 1.6 : 1;
    this.current.t += dt * speed;
    if (this.previous) {
      this.previous.t += dt;
      this.previous.weight -= dt / 0.22;
      if (this.previous.weight <= 0) this.previous = null;
    }
    const one = s.oneShot ? this.animFor(s.oneShot.slot) : null;

    const rot: [number, number, number] = [0, 0, 0];
    const pos: [number, number, number] = [0, 0, 0];
    const scl: [number, number, number] = [1, 1, 1];
    const tmpR: [number, number, number] = [0, 0, 0];
    const tmpP: [number, number, number] = [0, 0, 0];
    const tmpS: [number, number, number] = [1, 1, 1];
    const q = new Quaternion();
    const off = new Vector3();
    const t = s.time + this.seed;

    for (let i = 0; i < this.rig.length; i++) {
      const rb = this.rig[i];
      rot[0] = rot[1] = rot[2] = 0;
      pos[0] = pos[1] = pos[2] = 0;
      scl[0] = scl[1] = scl[2] = 1;
      const sample = (a: BedrockAnimation | null, time: number, w: number) => {
        if (!a || w <= 0) return;
        const tr = a.bones.get(rb.name);
        if (!tr) return;
        const at = a.loop === true ? time % a.length : Math.min(time, a.length);
        this.ctx.q.anim_time = at;
        this.ctx.q.life_time = s.time;
        if (sampleChannel(tr.rotation, at, this.ctx, tmpR)) for (let j = 0; j < 3; j++) rot[j] += tmpR[j] * w;
        if (sampleChannel(tr.position, at, this.ctx, tmpP)) for (let j = 0; j < 3; j++) pos[j] += tmpP[j] * w;
        if (sampleChannel(tr.scale, at, this.ctx, tmpS)) for (let j = 0; j < 3; j++) scl[j] *= 1 + (tmpS[j] - 1) * w;
      };
      const fade = this.previous ? Math.max(0, this.previous.weight) : 0;
      sample(this.current.anim, this.current.t, 1 - fade);
      if (this.previous) sample(this.previous.anim, this.previous.t, fade);
      if (one && s.oneShot) {
        const k = Math.min(1, s.oneShot.t / 0.1, (s.oneShot.length - s.oneShot.t) / 0.15);
        sample(one, s.oneShot.t, Math.max(0, k));
      }
      // Procedural layer: small life on top of (or instead of) authored clips
      procedural(this.roles[i], rot, t, s, !!this.current.anim);

      bedrockRotation(rb.restEuler[0] + rot[0], rb.restEuler[1] + rot[1], rb.restEuler[2] + rot[2], q);
      convertOffset(pos, off);
      const bone = this.bones[i];
      bone.setPosition(rb.offset.add(off), Space.LOCAL);
      bone.setRotationQuaternion(q, Space.LOCAL);
      bone.setScale(new Vector3(scl[0], scl[1], scl[2]));
    }
  }

  setEnergy(k: number): void {
    // Shared material: tint through the mesh's overlay instead
    this.mesh.renderOverlay = k > 0.01;
    this.mesh.overlayColor = new Color3(1, 0.35, 0.3);
    this.mesh.overlayAlpha = Math.min(0.85, k);
    void this.mat;
  }

  setEnabled(on: boolean): void {
    this.node.setEnabled(on);
  }

  meshes(): AbstractMesh[] {
    return [this.mesh];
  }

  dispose(): void {
    this.mesh.skeleton?.dispose();
    this.mesh.dispose();
    this.node.dispose();
  }
}

type Role = "head" | "neck" | "tail" | "ear" | "wingL" | "wingR" | "legL" | "legR" | "armL" | "armR" | "body" | "other";

function boneRole(name: string): Role {
  const n = name.toLowerCase();
  const left = /(^|_|\.)(l|left)($|_|\.|\d)|left|_l\d*$/.test(n);
  if (/head/.test(n)) return "head";
  if (/neck/.test(n)) return "neck";
  if (/tail/.test(n)) return "tail";
  if (/ear/.test(n)) return "ear";
  if (/wing/.test(n)) return left ? "wingL" : "wingR";
  if (/leg|foot|thigh/.test(n)) return left ? "legL" : "legR";
  if (/arm|hand/.test(n)) return left ? "armL" : "armR";
  if (/^(body|torso|chest|root|base)/.test(n)) return "body";
  return "other";
}

/** Additive procedural motion (degrees / Bedrock axes) so a Pokémon is never frozen. */
function procedural(role: Role, rot: [number, number, number], t: number, s: AnimState, hasClip: boolean): void {
  const moving = s.anim === "walk" || s.anim === "run";
  const turn = Math.max(-1, Math.min(1, s.turnRate / 3));
  switch (role) {
    case "body":
      rot[0] += Math.sin(t * 2.1) * 1.2; // breathing
      rot[2] += turn * 6; // lean into turns
      if (s.mode === "dive") rot[0] += Math.max(-25, Math.min(25, -s.climb * 10));
      break;
    case "head":
    case "neck":
      rot[0] += Math.sin(t * 0.7) * 3 + (moving ? Math.sin(t * 9) * 2 : 0);
      rot[1] += Math.sin(t * 0.43 + 1.3) * 7 * (moving ? 0.3 : 1) + turn * 14; // look around, lead turns
      break;
    case "tail":
      rot[1] += Math.sin(t * (moving ? 6 : 2.4)) * (moving ? 14 : 9);
      break;
    case "ear": {
      // Occasional quick twitch
      const ph = (t * 0.37) % 3;
      rot[2] += ph < 0.25 ? Math.sin((ph / 0.25) * Math.PI) * 18 : Math.sin(t * 1.3) * 2;
      break;
    }
    case "wingL":
    case "wingR": {
      const sign = role === "wingL" ? 1 : -1;
      if (!hasClip && s.mode === "fly") {
        const glide = s.climb < -0.6;
        rot[2] += sign * (glide ? 10 : Math.sin(t * 9) * 45);
      } else rot[2] += sign * Math.sin(t * 1.8) * 3;
      break;
    }
    case "legL":
    case "legR":
    case "armL":
    case "armR":
      if (!hasClip && moving) {
        const phase = role === "legL" || role === "armR" ? 0 : Math.PI;
        rot[0] += Math.sin(t * (s.anim === "run" ? 13 : 8) + phase) * (s.anim === "run" ? 32 : 22);
      }
      break;
    default:
      break;
  }
}

function baseSlot(s: AnimState): string {
  const turning = Math.abs(s.turnRate) > 1.2;
  switch (s.anim) {
    case "battle":
      return "battle_idle";
    case "sleep":
      return "sleep";
    case "walk":
      return turning ? "walk" : "walk";
    case "run":
      return "run";
    case "swim":
      if (s.mode === "dive") return "dive";
      return "swim";
    case "fly":
      return s.climb < -0.8 ? "glide" : "fly";
    default:
      if (s.mode === "swim") return turning ? "turn_water" : "idle_water";
      if (s.mode === "dive") return "dive";
      if (s.mode === "fly") return turning ? "turn_air" : "idle_air";
      return turning ? "turn" : "idle";
  }
}

// ---------------------------------------------------------------- glTF body

class GltfBody implements PokemonBody {
  readonly kind = "gltf" as const;
  readonly node: TransformNode;
  readonly height: number;
  private readonly groups: AnimationGroup[];
  private readonly all: AbstractMesh[] = [];
  private playing: AnimationGroup | null = null;
  private slot = "";

  constructor(scene: Scene, loaded: Extract<LoadedModel, { kind: "gltf" }>, name: string) {
    this.node = new TransformNode(`${name}_body`, scene);
    const inst = loaded.container.instantiateModelsToScene((n) => `${name}_${n}`, false, { doNotInstantiate: true });
    for (const r of inst.rootNodes) {
      r.parent = this.node;
      for (const m of r.getChildMeshes(false)) this.all.push(m);
    }
    this.groups = inst.animationGroups;
    for (const g of this.groups) g.stop();
    this.height = loaded.height;
  }

  private group(slot: string): AnimationGroup | null {
    for (const n of SLOT_NAMES[slot] ?? [slot]) {
      const g = this.groups.find((x) => x.name.toLowerCase().includes(n));
      if (g) return g;
    }
    return null;
  }

  update(dt: number, s: AnimState): void {
    const slot = s.oneShot?.slot ?? baseSlot(s);
    if (slot !== this.slot) {
      this.slot = slot;
      const g = this.group(slot) ?? this.group("idle");
      if (g !== this.playing) {
        this.playing?.stop();
        g?.start(!s.oneShot, 1);
        this.playing = g;
      }
    }
    // Breathing on the whole model even without clips
    this.node.scaling.y = 1 + Math.sin(s.time * 2.1) * 0.012;
    void dt;
  }

  setEnergy(k: number): void {
    for (const m of this.all) {
      m.renderOverlay = k > 0.01;
      m.overlayColor = new Color3(1, 0.35, 0.3);
      m.overlayAlpha = Math.min(0.85, k);
    }
  }

  setEnabled(on: boolean): void {
    this.node.setEnabled(on);
  }

  meshes(): AbstractMesh[] {
    return this.all;
  }

  dispose(): void {
    for (const g of this.groups) g.dispose();
    this.node.dispose(false, true);
  }
}

// ---------------------------------------------------------------- missing marker

/** Clearly labelled "no model" marker the size of the species' hitbox. */
class MissingBody implements PokemonBody {
  readonly kind = "missing" as const;
  readonly node: TransformNode;
  readonly height: number;
  private readonly box: InstancedMesh;
  private readonly label: InstancedMesh;

  constructor(scene: Scene, box: Mesh, label: Mesh, species: SpeciesDef, name: string) {
    this.node = new TransformNode(`${name}_missing`, scene);
    this.box = box.createInstance(`${name}_mbox`);
    this.box.parent = this.node;
    this.box.scaling.set(species.hitbox.width, species.hitbox.height, species.hitbox.width);
    this.box.position.y = species.hitbox.height / 2;
    this.label = label.createInstance(`${name}_mlabel`);
    this.label.parent = this.node;
    this.label.position.y = species.hitbox.height + 0.45;
    this.label.billboardMode = 7;
    this.height = species.hitbox.height;
  }

  update(_dt: number, s: AnimState): void {
    // A missing asset is not animated as a creature; it only marks the spot
    this.box.rotation.y = Math.sin(s.time * 0.8) * 0.05;
    // The billboard would fill the screen right in front of the camera
    const cam = this.node.getScene().activeCamera;
    if (cam) {
      const near = Vector3.DistanceSquared(cam.globalPosition, this.label.getAbsolutePosition()) < 9;
      if (this.label.isEnabled() === near) this.label.setEnabled(!near);
    }
  }

  setEnergy(k: number): void {
    this.box.visibility = 1 - k * 0.6;
  }

  setEnabled(on: boolean): void {
    this.node.setEnabled(on);
  }

  meshes(): AbstractMesh[] {
    return [this.box];
  }

  dispose(): void {
    this.box.dispose();
    this.label.dispose();
    this.node.dispose();
  }
}

export interface BodyFactory {
  missing(species: SpeciesDef, name: string): PokemonBody;
}

export function makeBody(scene: Scene, loaded: LoadedModel, species: SpeciesDef, name: string): PokemonBody {
  return loaded.kind === "bedrock" ? new BedrockBody(scene, loaded, species, name) : new GltfBody(scene, loaded, name);
}

export function makeMissingBody(scene: Scene, box: Mesh, label: Mesh, species: SpeciesDef, name: string): PokemonBody {
  return new MissingBody(scene, box, label, species, name);
}

// ---------------------------------------------------------------- view

let nextId = 1;

/**
 * One Pokémon on screen. `root` is placed in the world by its owner (wild
 * manager, companion, battle); everything below it (scale, bob, lunge,
 * capture shrink, faint) is driven here. The body is swapped in place when a
 * model finishes loading or is imported.
 */
export class PokemonView {
  readonly root: TransformNode;
  /** Carries one-shot motion (lunge, shake) and the capture shrink. */
  private readonly rig: TransformNode;
  body: PokemonBody;
  anim: CreatureAnim = "idle";
  mode: WildMode = "walk";
  size = 1;
  alpha = false;
  status: AssetStatus = "missing";
  private time = Math.random() * 10;
  private oneShot: { slot: string; t: number; length: number } | null = null;
  private lungeT = -1;
  private hitT = -1;
  private faintT = -1;
  private lastYaw = 0;
  private turnRate = 0;
  private lastY = 0;
  private climb = 0;
  /** 0..1 capture shrink (1 = gone into the ball). */
  captureShrink = 0;
  readonly id = nextId++;

  constructor(
    scene: Scene,
    readonly species: SpeciesDef,
    body: PokemonBody,
    private modelScale: number,
  ) {
    this.root = new TransformNode(`pk_${species.id}_${this.id}`, scene);
    this.rig = new TransformNode(`pkrig_${this.id}`, scene);
    this.rig.parent = this.root;
    this.body = body;
    body.node.parent = this.rig;
  }

  /** Replaces the body (model loaded or changed). */
  setBody(body: PokemonBody, modelScale: number): void {
    this.body.dispose();
    this.body = body;
    body.node.parent = this.rig;
    this.modelScale = modelScale;
  }

  /** Overall world scale: species baseScale x individual size x asset scale. */
  get scale(): number {
    const base = this.body.kind === "missing" ? 1 : this.species.baseScale * this.modelScale;
    return base * this.size;
  }

  /** Height of the top of the model in world units (name tags, capture beam). */
  get height(): number {
    if (this.body.kind === "missing") return this.species.hitbox.height * this.size;
    return Math.max(0.3, this.body.height * this.scale);
  }

  get width(): number {
    return this.species.hitbox.width * this.size;
  }

  reset(): void {
    this.anim = "idle";
    this.oneShot = null;
    this.lungeT = this.hitT = this.faintT = -1;
    this.captureShrink = 0;
    this.rig.position.setAll(0);
    this.rig.rotation.setAll(0);
    this.body.setEnergy(0);
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on);
  }

  playAttack(special = false): void {
    this.oneShot = { slot: special ? "special" : "physical", t: 0, length: 0.7 };
    if (!special) this.lungeT = 0;
  }

  playHit(): void {
    this.oneShot = { slot: "damage", t: 0, length: 0.45 };
    this.hitT = 0;
  }

  playRecoil(): void {
    this.oneShot = { slot: "recoil", t: 0, length: 0.8 };
    this.hitT = 0;
  }

  playFaint(): void {
    this.oneShot = { slot: "faint", t: 0, length: 1.2 };
    this.faintT = 0;
  }

  get fainted(): boolean {
    return this.faintT >= 0;
  }

  setEnergy(k: number): void {
    this.body.setEnergy(k);
  }

  update(dt: number): void {
    this.time += dt;
    const yaw = this.root.rotation.y;
    let dy = yaw - this.lastYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.turnRate += (dy / Math.max(1e-3, dt) - this.turnRate) * Math.min(1, dt * 6);
    this.lastYaw = yaw;
    const y = this.root.position.y;
    this.climb += ((y - this.lastY) / Math.max(1e-3, dt) - this.climb) * Math.min(1, dt * 4);
    this.lastY = y;

    if (this.oneShot) {
      this.oneShot.t += dt;
      if (this.oneShot.t >= this.oneShot.length && this.oneShot.slot !== "faint") this.oneShot = null;
    }
    const s: AnimState = { anim: this.anim, mode: this.mode, turnRate: this.turnRate, climb: this.climb, oneShot: this.oneShot, time: this.time };
    this.body.update(dt, s);

    // Whole-body motion shared by every asset type
    let lunge = 0;
    if (this.lungeT >= 0) {
      this.lungeT += dt;
      const k = this.lungeT / 0.45;
      lunge = k < 1 ? Math.sin(k * Math.PI) * 0.6 : 0;
      if (k >= 1) this.lungeT = -1;
    }
    let shake = 0;
    if (this.hitT >= 0) {
      this.hitT += dt;
      shake = this.hitT < 0.35 ? Math.sin(this.hitT * 60) * 0.08 : 0;
      if (this.hitT >= 0.35) this.hitT = -1;
    }
    const sc = this.scale * (1 - this.captureShrink);
    if (this.faintT >= 0) {
      this.faintT = Math.min(1, this.faintT + dt);
      // Without a faint clip: tip over and sink a little
      if (this.body.kind !== "bedrock" || !(this.body as unknown as { hasClip(s: string): boolean }).hasClip("faint")) {
        this.rig.rotation.z = this.faintT * (Math.PI / 2);
        this.rig.position.y = -0.15 * this.faintT;
      }
      this.rig.scaling.setAll(sc);
      return;
    }
    const bob = this.mode === "swim" ? Math.sin(this.time * 2) * 0.05 : this.mode === "fly" ? Math.sin(this.time * 2.4) * 0.12 : 0;
    this.rig.position.set(shake, bob, lunge * Math.max(0.6, this.width));
    this.rig.rotation.z = 0;
    this.rig.scaling.setAll(Math.max(0.0001, sc));
  }

  dispose(): void {
    this.body.dispose();
    this.root.dispose();
  }
}

export { DEG };
