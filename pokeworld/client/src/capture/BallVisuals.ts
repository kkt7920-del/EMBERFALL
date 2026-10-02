import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import "@babylonjs/core/Particles/particleSystemComponent";
import type { Scene } from "@babylonjs/core/scene";
import { BALL } from "@shared/capture/ballPhysics";
import type { ContentDB } from "@shared/data/contentDb";
import type { BallLook } from "@shared/types/content";

const R = BALL.radius;

/** A Poké Ball in the scene: two hinged halves, band, button. */
export class BallModel {
  readonly root: TransformNode;
  /** Rotated by the physics spin; the halves hang under it. */
  readonly spin: TransformNode;
  private readonly hinge: TransformNode;
  private readonly buttonMat: StandardMaterial;
  private readonly meshes: Mesh[] = [];
  private glow = 0;

  constructor(scene: Scene, look: BallLook, mats: Map<string, StandardMaterial>, name: string) {
    this.root = new TransformNode(name, scene);
    this.spin = new TransformNode(`${name}_spin`, scene);
    this.spin.parent = this.root;
    const mat = (key: string, make: () => StandardMaterial) => {
      let m = mats.get(key);
      if (!m) mats.set(key, (m = make()));
      return m;
    };
    const topMat = mat(`top:${look.top}:${look.stripe ?? ""}`, () => {
      const m = new StandardMaterial(`ballTop_${look.top}`, scene);
      m.diffuseTexture = paintTop(scene, look);
      m.specularColor = new Color3(0.9, 0.9, 0.9);
      m.specularPower = 48;
      return m;
    });
    const bottomMat = mat(`col:${look.bottom}`, () => solid(scene, look.bottom));
    const bandMat = mat(`col:${look.band}`, () => solid(scene, look.band, 0.2));
    const insideMat = mat("inside", () => solid(scene, "#2a2a30", 0));
    this.buttonMat = new StandardMaterial(`${name}_btn`, scene);
    this.buttonMat.diffuseColor = Color3.FromHexString(look.button);
    this.buttonMat.specularColor = new Color3(1, 1, 1);

    // Hinge at the back of the band: the top half swings open around it
    this.hinge = new TransformNode(`${name}_hinge`, scene);
    this.hinge.parent = this.spin;
    this.hinge.position.set(0, 0, -R);
    const top = CreateSphere(`${name}_top`, { diameter: R * 2, segments: 12, slice: 0.5 }, scene);
    top.material = topMat;
    top.parent = this.hinge;
    top.position.set(0, 0, R);
    const topCap = CreateDisc(`${name}_tcap`, { radius: R * 0.98, tessellation: 20 }, scene);
    topCap.rotation.x = -Math.PI / 2;
    topCap.material = insideMat;
    topCap.parent = top;
    const bottom = CreateSphere(`${name}_bottom`, { diameter: R * 2, segments: 12, slice: 0.5 }, scene);
    bottom.rotation.x = Math.PI;
    bottom.material = bottomMat;
    bottom.parent = this.spin;
    const botCap = CreateDisc(`${name}_bcap`, { radius: R * 0.98, tessellation: 20 }, scene);
    botCap.rotation.x = Math.PI / 2;
    botCap.material = insideMat;
    botCap.parent = this.spin;
    const band = CreateTorus(`${name}_band`, { diameter: R * 2, thickness: R * 0.16, tessellation: 24 }, scene);
    band.material = bandMat;
    band.parent = this.spin;
    const button = CreateCylinder(`${name}_btn`, { diameter: R * 0.55, height: R * 0.18, tessellation: 14 }, scene);
    button.rotation.x = Math.PI / 2;
    button.position.set(0, 0, R * 0.98);
    button.material = this.buttonMat;
    button.parent = this.spin;
    const ring = CreateTorus(`${name}_ring`, { diameter: R * 0.62, thickness: R * 0.09, tessellation: 16 }, scene);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0, R * 0.99);
    ring.material = bandMat;
    ring.parent = this.spin;
    this.meshes.push(top, topCap, bottom, botCap, band, button, ring);
    for (const m of this.meshes) {
      m.isPickable = false;
      m.receiveShadows = false;
    }
  }

  /** 0 = closed, 1 = wide open. */
  setOpen(k: number): void {
    this.hinge.rotation.x = -k * 1.9;
  }

  /** Button light 0..1. */
  setGlow(k: number): void {
    if (Math.abs(k - this.glow) < 0.01) return;
    this.glow = k;
    this.buttonMat.emissiveColor = new Color3(k, k * 0.92, k * 0.75);
  }

  setVisible(on: boolean): void {
    this.root.setEnabled(on);
  }

  dispose(): void {
    this.buttonMat.dispose();
    this.root.dispose(false, false);
  }
}

function solid(scene: Scene, hex: string, spec = 0.7): StandardMaterial {
  const m = new StandardMaterial(`ball_${hex}`, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(spec, spec, spec);
  m.specularPower = 40;
  return m;
}

/** Top-half texture: base colour with the ball type's markings. */
function paintTop(scene: Scene, look: BallLook): DynamicTexture {
  const t = new DynamicTexture(`ballTex_${look.top}_${look.stripe ?? "x"}`, { width: 128, height: 64 }, scene, true);
  const g = t.getContext() as CanvasRenderingContext2D;
  g.fillStyle = look.top;
  g.fillRect(0, 0, 128, 64);
  if (look.stripe) {
    g.fillStyle = look.stripe;
    if (look.top === "#2a2a2a") {
      // Ultra: H-shaped bars on both sides
      for (const x of [22, 86]) {
        g.fillRect(x, 6, 6, 58);
        g.fillRect(x + 14, 6, 6, 58);
      }
    } else if (look.top === "#2aa8a8") {
      g.lineWidth = 2;
      g.strokeStyle = look.stripe;
      for (let x = 0; x < 128; x += 12) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x + 12, 64);
        g.stroke();
      }
    } else {
      // Side patches (Great, Repeat, Quick, Dive, Dusk, Timer)
      for (const x of [20, 84]) g.fillRect(x, 10, 24, 30);
    }
  }
  // Specular highlight hint
  g.fillStyle = "rgba(255,255,255,0.25)";
  g.fillRect(52, 6, 12, 10);
  t.update();
  return t;
}

/**
 * Capture effects under the quality's particle budget: ThrowTrail,
 * ImpactSpark, CaptureBeam, CaptureEnergy, BallGlow (button light + point
 * light), ShakeFlash, CaptureStarBurst, BreakoutBurst.
 */
export class CaptureFx {
  private readonly spark: DynamicTexture;
  private readonly star: DynamicTexture;
  private readonly bursts: ParticleSystem;
  private readonly stars: ParticleSystem;
  private readonly energy: ParticleSystem;
  private readonly trails: ParticleSystem[] = [];
  readonly beam: Mesh;
  private readonly beamMat: StandardMaterial;
  private readonly flashSphere: Mesh;
  private readonly flashMat: StandardMaterial;
  readonly light: PointLight;
  private flashT = 0;
  private flashDur = 0;
  private flashColor = new Color3(1, 1, 1);

  constructor(
    private readonly scene: Scene,
    private budget: number,
  ) {
    this.spark = radial(scene, "capSpark");
    this.star = starTexture(scene);
    const cap = (n: number) => Math.max(12, Math.min(n, Math.floor(this.budget * 0.35)));
    this.bursts = this.system("capBurst", cap(220), this.spark);
    this.stars = this.system("capStars", cap(80), this.star);
    this.stars.minSize = 0.12;
    this.stars.maxSize = 0.3;
    this.stars.gravity = new Vector3(0, -2.5, 0);
    this.energy = this.system("capEnergy", cap(160), this.spark);
    this.energy.minEmitPower = -2.5;
    this.energy.maxEmitPower = -1;
    this.energy.minLifeTime = 0.3;
    this.energy.maxLifeTime = 0.6;
    this.energy.gravity = Vector3.Zero();

    this.beamMat = new StandardMaterial("beamMat", scene);
    this.beamMat.emissiveColor = new Color3(1, 0.45, 0.4);
    this.beamMat.disableLighting = true;
    this.beamMat.alpha = 0.55;
    this.beam = CreateCylinder("captureBeam", { diameterTop: 0.05, diameterBottom: 0.4, height: 1, tessellation: 10 }, scene);
    this.beam.material = this.beamMat;
    this.beam.isPickable = false;
    this.beam.setEnabled(false);

    this.flashMat = new StandardMaterial("flashMat", scene);
    this.flashMat.emissiveColor = Color3.White();
    this.flashMat.disableLighting = true;
    this.flashMat.alpha = 0;
    this.flashSphere = CreateSphere("captureFlash", { diameter: 1, segments: 10 }, scene);
    this.flashSphere.material = this.flashMat;
    this.flashSphere.isPickable = false;
    this.flashSphere.setEnabled(false);

    this.light = new PointLight("captureLight", Vector3.Zero(), scene);
    this.light.diffuse = new Color3(1, 0.55, 0.45);
    this.light.specular = Color3.Black();
    this.light.range = 9;
    this.light.intensity = 0;
  }

  private system(name: string, capacity: number, tex: DynamicTexture): ParticleSystem {
    const ps = new ParticleSystem(name, capacity, this.scene);
    ps.particleTexture = tex;
    ps.emitter = Vector3.Zero();
    ps.minEmitPower = 1.5;
    ps.maxEmitPower = 5;
    ps.minLifeTime = 0.25;
    ps.maxLifeTime = 0.7;
    ps.minSize = 0.06;
    ps.maxSize = 0.2;
    ps.direction1 = new Vector3(-1, -0.4, -1);
    ps.direction2 = new Vector3(1, 1.6, 1);
    ps.gravity = new Vector3(0, -5, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.start();
    return ps;
  }

  private emit(ps: ParticleSystem, at: Vector3, count: number, c1: Color4, c2: Color4): void {
    (ps.emitter as Vector3).copyFrom(at);
    ps.color1 = c1;
    ps.color2 = c2;
    ps.colorDead = new Color4(c1.r, c1.g, c1.b, 0);
    ps.manualEmitCount = Math.min(ps.getCapacity(), Math.max(1, Math.round(count * Math.min(1, this.budget / 400))));
  }

  /** Streak behind a flying ball. */
  trail(): { follow(at: Vector3): void; stop(): void } {
    const ps = this.trails.pop() ?? this.system("capTrail", Math.max(8, Math.min(40, Math.floor(this.budget * 0.05))), this.spark);
    ps.minEmitPower = 0;
    ps.maxEmitPower = 0.2;
    ps.minLifeTime = 0.18;
    ps.maxLifeTime = 0.3;
    ps.gravity = Vector3.Zero();
    ps.color1 = new Color4(1, 1, 1, 0.8);
    ps.color2 = new Color4(1, 0.85, 0.6, 0.6);
    ps.colorDead = new Color4(1, 1, 1, 0);
    ps.emitRate = Math.min(90, this.budget * 0.12);
    const at = new Vector3();
    ps.emitter = at;
    return {
      follow: (p) => at.copyFrom(p),
      stop: () => {
        ps.emitRate = 0;
        this.trails.push(ps);
      },
    };
  }

  impactSpark(at: Vector3): void {
    this.emit(this.bursts, at, 26, new Color4(1, 1, 0.85, 1), new Color4(1, 0.6, 0.3, 1));
  }

  /** Beam from the open ball to the Pokémon (k: 0..1 intensity). */
  setBeam(from: Vector3 | null, to?: Vector3, k = 1): void {
    if (!from || !to) {
      this.beam.setEnabled(false);
      return;
    }
    const d = to.subtract(from);
    const len = d.length();
    this.beam.setEnabled(true);
    this.beam.position.copyFrom(from.add(d.scale(0.5)));
    this.beam.scaling.set(0.4 + k * 1.2, len, 0.4 + k * 1.2);
    // Cylinder axis is +Y: rotate it onto the beam direction
    const dir = d.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = Math.acos(Math.max(-1, Math.min(1, dir.y)));
    this.beam.rotation.set(pitch, yaw, 0);
    this.beamMat.alpha = 0.25 + 0.45 * k;
  }

  /** Red-white energy pulled from the Pokémon toward the ball. */
  captureEnergy(at: Vector3, radius: number): void {
    const ps = this.energy;
    ps.minEmitBox = new Vector3(-radius, 0, -radius);
    ps.maxEmitBox = new Vector3(radius, radius * 1.6, radius);
    this.emit(ps, at, 14, new Color4(1, 0.4, 0.35, 1), new Color4(1, 1, 1, 1));
  }

  shakeFlash(at: Vector3): void {
    this.emit(this.bursts, at, 6, new Color4(1, 1, 0.8, 1), new Color4(1, 0.9, 0.6, 1));
  }

  starBurst(at: Vector3): void {
    this.emit(this.stars, at, 40, new Color4(1, 0.92, 0.35, 1), new Color4(1, 1, 1, 1));
    this.flash(at, new Color3(1, 0.95, 0.6), 0.35, 1.2);
  }

  breakoutBurst(at: Vector3): void {
    this.emit(this.bursts, at, 70, new Color4(1, 1, 1, 1), new Color4(1, 0.35, 0.3, 1));
    this.flash(at, new Color3(1, 1, 1), 0.45, 2.6);
  }

  criticalFlash(at: Vector3): void {
    this.emit(this.stars, at, 24, new Color4(0.7, 0.95, 1, 1), new Color4(1, 1, 1, 1));
    this.flash(at, new Color3(0.75, 0.95, 1), 0.4, 1.8);
  }

  /** Expanding glow sphere + point light. */
  flash(at: Vector3, color: Color3, duration: number, size: number): void {
    this.flashSphere.position.copyFrom(at);
    this.flashSphere.setEnabled(true);
    this.flashSphere.scaling.setAll(0.2);
    (this.flashSphere as Mesh & { _flashSize?: number })._flashSize = size;
    this.flashColor = color;
    this.flashMat.emissiveColor = color;
    this.flashT = 0;
    this.flashDur = duration;
    this.light.position.copyFrom(at);
    this.light.diffuse = color;
  }

  /** Keeps the capture light on (beam phase). */
  setLight(at: Vector3 | null, intensity = 0): void {
    if (at) this.light.position.copyFrom(at);
    this.light.intensity = intensity;
  }

  update(dt: number): void {
    if (this.flashDur > 0) {
      this.flashT += dt;
      const k = Math.min(1, this.flashT / this.flashDur);
      const size = (this.flashSphere as Mesh & { _flashSize?: number })._flashSize ?? 1;
      this.flashSphere.scaling.setAll(0.2 + k * size);
      this.flashMat.alpha = 0.85 * (1 - k);
      this.light.intensity = Math.max(this.light.intensity * 0.9, 3 * (1 - k));
      if (k >= 1) {
        this.flashDur = 0;
        this.flashSphere.setEnabled(false);
      }
    }
    void this.flashColor;
  }

  setBudget(n: number): void {
    this.budget = n;
  }
}

function radial(scene: Scene, name: string): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 32, height: 32 }, scene, false);
  const g = tex.getContext() as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

function starTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture("capStar", { width: 64, height: 64 }, scene, false);
  const g = tex.getContext() as CanvasRenderingContext2D;
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = "#ffffff";
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 12 : 30;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const x = 32 + Math.cos(a) * r;
    const y = 32 + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

/** Ball look for an item, with a sensible default. */
export function ballLook(db: ContentDB, item: string): BallLook {
  return db.items.get(item)?.ball ?? { top: "#e3350d", bottom: "#f4f4f4", band: "#1e1e1e", button: "#f4f4f4" };
}
