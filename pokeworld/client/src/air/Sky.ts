import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import "@babylonjs/core/Particles/particleSystemComponent";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Scene } from "@babylonjs/core/scene";
import { hash2 } from "@shared/math/rng";
import { clamp, lerp } from "@shared/math/vec";
import type { Weather } from "@shared/types/content";
import type { WorldClock } from "@shared/types/game";

interface SkyKey {
  hour: number;
  top: [number, number, number];
  horizon: [number, number, number];
  sun: number;
  hemi: number;
  ground: [number, number, number];
}

// Sky colour keyframes over a day
const KEYS: SkyKey[] = [
  // Night keeps enough moonlight to recognise Pokémon
  { hour: 0, top: [0.03, 0.05, 0.14], horizon: [0.09, 0.12, 0.26], sun: 0.28, hemi: 0.5, ground: [0.1, 0.11, 0.18] },
  { hour: 5, top: [0.06, 0.08, 0.2], horizon: [0.24, 0.18, 0.3], sun: 0.25, hemi: 0.48, ground: [0.12, 0.12, 0.18] },
  { hour: 6.5, top: [0.32, 0.46, 0.75], horizon: [0.98, 0.66, 0.46], sun: 0.6, hemi: 0.55, ground: [0.32, 0.26, 0.22] },
  { hour: 9, top: [0.3, 0.56, 0.95], horizon: [0.68, 0.84, 0.98], sun: 1.0, hemi: 0.7, ground: [0.36, 0.34, 0.3] },
  { hour: 16, top: [0.3, 0.55, 0.93], horizon: [0.7, 0.84, 0.96], sun: 0.95, hemi: 0.68, ground: [0.36, 0.34, 0.3] },
  { hour: 18.2, top: [0.36, 0.34, 0.62], horizon: [0.98, 0.52, 0.36], sun: 0.55, hemi: 0.5, ground: [0.3, 0.22, 0.2] },
  { hour: 19.8, top: [0.07, 0.08, 0.22], horizon: [0.22, 0.16, 0.32], sun: 0.25, hemi: 0.48, ground: [0.12, 0.12, 0.18] },
  { hour: 24, top: [0.03, 0.05, 0.14], horizon: [0.09, 0.12, 0.26], sun: 0.28, hemi: 0.5, ground: [0.1, 0.11, 0.18] },
];

function sample(hour: number): SkyKey {
  for (let i = 0; i + 1 < KEYS.length; i++) {
    const a = KEYS[i];
    const b = KEYS[i + 1];
    if (hour >= a.hour && hour <= b.hour) {
      const t = (hour - a.hour) / (b.hour - a.hour);
      const mix = (x: [number, number, number], y: [number, number, number]): [number, number, number] => [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)];
      return { hour, top: mix(a.top, b.top), horizon: mix(a.horizon, b.horizon), sun: lerp(a.sun, b.sun, t), hemi: lerp(a.hemi, b.hemi, t), ground: mix(a.ground, b.ground) };
    }
  }
  return KEYS[0];
}

/** Sky dome, sun/moon, clouds, day-night lighting, fog and weather. */
export class Sky {
  readonly hemi: HemisphericLight;
  readonly sun: DirectionalLight;
  readonly lantern: PointLight;
  private readonly dome: Mesh;
  private readonly gradient: DynamicTexture;
  private readonly sunDisc: Mesh;
  private readonly moonDisc: Mesh;
  private readonly clouds: Mesh;
  private readonly cloudOffsets: Float32Array;
  private rain: ParticleSystem | null = null;
  private clock: WorldClock = { time: 0, hour: 9, period: "day", weather: "clear" };
  private clockReceivedAt = performance.now();
  private underground = false;
  private underwater = false;
  private fogEnd = 200;
  private lastGradientHour = -1;
  readonly sunDirection = new Vector3(-0.4, -1, 0.3);

  constructor(
    private readonly scene: Scene,
    private particleBudget: number,
  ) {
    scene.fogMode = Scene.FOGMODE_LINEAR;

    this.hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
    this.sun = new DirectionalLight("sun", this.sunDirection, scene);
    this.sun.position = new Vector3(0, 100, 0);
    this.lantern = new PointLight("lantern", Vector3.Zero(), scene);
    this.lantern.diffuse = new Color3(1, 0.85, 0.6);
    this.lantern.specular = Color3.Black();
    this.lantern.range = 16;
    this.lantern.intensity = 0;

    this.gradient = new DynamicTexture("skyGradient", { width: 4, height: 64 }, scene, false);
    this.gradient.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.gradient.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.dome = CreateSphere("skyDome", { diameter: 1600, segments: 16, sideOrientation: 1 }, scene);
    const domeMat = new StandardMaterial("skyMat", scene);
    domeMat.emissiveTexture = this.gradient;
    domeMat.disableLighting = true;
    domeMat.fogEnabled = false;
    domeMat.backFaceCulling = false;
    this.dome.material = domeMat;
    this.dome.infiniteDistance = true;
    this.dome.isPickable = false;
    this.dome.applyFog = false;

    const disc = (name: string, color: Color3, size: number) => {
      const m = CreateDisc(name, { radius: size, tessellation: 20 }, scene);
      const mat = new StandardMaterial(`${name}Mat`, scene);
      mat.emissiveColor = color;
      mat.disableLighting = true;
      mat.fogEnabled = false;
      m.material = mat;
      m.billboardMode = 7;
      m.isPickable = false;
      m.infiniteDistance = true;
      return m;
    };
    this.sunDisc = disc("sunDisc", new Color3(1, 0.95, 0.7), 34);
    this.moonDisc = disc("moonDisc", new Color3(0.85, 0.9, 1), 20);

    // Blocky clouds as thin instances
    this.clouds = CreateBox("clouds", { size: 1 }, scene);
    const cloudMat = new StandardMaterial("cloudMat", scene);
    cloudMat.diffuseColor = new Color3(1, 1, 1);
    cloudMat.emissiveColor = new Color3(0.55, 0.55, 0.6);
    cloudMat.specularColor = Color3.Black();
    cloudMat.alpha = 0.88;
    this.clouds.material = cloudMat;
    this.clouds.isPickable = false;
    const n = 28;
    this.cloudOffsets = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) this.cloudOffsets.set([hash2(i, 1, 9) * 900 - 450, 158 + hash2(i, 2, 9) * 16, hash2(i, 3, 9) * 900 - 450], i * 3);
    this.clouds.thinInstanceSetBuffer("matrix", new Float32Array(n * 16), 16, false);
  }

  setClock(clock: WorldClock): void {
    this.clock = clock;
    this.clockReceivedAt = performance.now();
  }

  /** Hour advanced locally between server clock updates (20 min/day). */
  get hour(): number {
    const elapsed = (performance.now() - this.clockReceivedAt) / 1000;
    return (this.clock.hour + (elapsed / (20 * 60)) * 24) % 24;
  }

  get weather(): Weather {
    return this.clock.weather;
  }

  /** Under a cave roof: dark fog, no sky. */
  setUnderground(on: boolean): void {
    if (on === this.underground) return;
    this.underground = on;
    this.dome.setEnabled(!on);
    this.sunDisc.setEnabled(!on);
    this.moonDisc.setEnabled(!on);
    this.clouds.setEnabled(!on);
  }

  /** Camera below the water surface: blue fog that thickens with depth. */
  setUnderwater(depth: number | null): void {
    this.underwater = depth !== null;
    this.waterDepth = depth ?? 0;
  }

  private waterDepth = 0;

  get isUnderground(): boolean {
    return this.underground;
  }

  /** Day phase label for the HUD. */
  get phase(): "DAWN" | "DAY" | "AFTERNOON" | "SUNSET" | "NIGHT" {
    const h = this.hour;
    if (h >= 5 && h < 7) return "DAWN";
    if (h >= 7 && h < 12) return "DAY";
    if (h >= 12 && h < 17) return "AFTERNOON";
    if (h >= 17 && h < 19.5) return "SUNSET";
    return "NIGHT";
  }

  setViewDistance(metres: number): void {
    this.fogEnd = metres;
  }

  setParticleBudget(n: number): void {
    this.particleBudget = n;
    this.rain?.dispose();
    this.rain = null;
  }

  update(dt: number, focus: Vector3, cameraPos: Vector3): void {
    const scene = this.scene;
    const hour = this.hour;
    const k = sample(hour);

    if (this.underwater) {
      const d = Math.min(1, this.waterDepth / 40);
      const c = new Color3(0.08 - d * 0.06, 0.28 - d * 0.2, 0.45 - d * 0.28).scale(Math.max(0.35, k.hemi + 0.3));
      scene.clearColor = new Color4(c.r, c.g, c.b, 1);
      scene.fogColor = c;
      scene.fogStart = 1;
      scene.fogEnd = 34 - d * 16;
    }
    if (this.underground) {
      const c = new Color3(0.05, 0.045, 0.07);
      scene.clearColor = new Color4(c.r, c.g, c.b, 1);
      scene.fogColor = c;
      scene.fogStart = 8;
      scene.fogEnd = 46;
      this.hemi.intensity = 0.42;
      this.hemi.diffuse = new Color3(0.62, 0.58, 0.8);
      this.hemi.groundColor = new Color3(0.12, 0.1, 0.16);
      this.sun.intensity = 0;
      this.lantern.intensity = 1.25;
      this.lantern.position.set(focus.x, focus.y + 2.2, focus.z);
      this.updateRain(false, cameraPos);
      if (this.underwater) {
        scene.fogStart = 1;
        scene.fogEnd = 18;
      }
      return;
    }

    const rain = this.clock.weather === "rain";
    const fog = this.clock.weather === "fog";
    const dim = rain ? 0.7 : fog ? 0.85 : 1;

    const horizon = new Color3(k.horizon[0] * dim, k.horizon[1] * dim, k.horizon[2] * dim);
    if (!this.underwater) {
      scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
      scene.fogColor = horizon;
      scene.fogEnd = fog ? Math.min(this.fogEnd, 70) : this.fogEnd;
      scene.fogStart = scene.fogEnd * (fog ? 0.15 : 0.5);
    }

    if (Math.abs(hour - this.lastGradientHour) > 0.05 || dim !== 1) {
      this.lastGradientHour = hour;
      const g = this.gradient.getContext() as CanvasRenderingContext2D;
      const grad = g.createLinearGradient(0, 0, 0, 64);
      const css = (c: [number, number, number], m = 1) => `rgb(${(c[0] * dim * m * 255) | 0},${(c[1] * dim * m * 255) | 0},${(c[2] * dim * m * 255) | 0})`;
      grad.addColorStop(0, css(k.top));
      grad.addColorStop(0.46, css(k.horizon));
      grad.addColorStop(0.54, css(k.horizon, 0.9));
      grad.addColorStop(1, css(k.ground));
      g.fillStyle = grad;
      g.fillRect(0, 0, 4, 64);
      this.gradient.update(false);
    }

    // Sun path: rises in the east (+x) at 6h, sets in the west at 18h
    const a = ((hour - 6) / 12) * Math.PI;
    const sunDir = new Vector3(Math.cos(a), Math.sin(a), 0.35).normalize();
    const above = sunDir.y > -0.05;
    const lightDir = above ? sunDir : new Vector3(-sunDir.x, -sunDir.y, sunDir.z);
    this.sunDirection.copyFrom(lightDir.scale(-1));
    this.sun.direction.copyFrom(this.sunDirection);
    this.sun.position.copyFrom(focus.subtract(this.sunDirection.scale(80)));
    // Top faces get hemi + sun; keep the sum near 1 so textures don't wash out
    this.sun.intensity = k.sun * 0.62 * dim * (above ? 1 : 0.45);
    this.sun.diffuse = above ? new Color3(1, 0.95, 0.85) : new Color3(0.62, 0.72, 1);
    this.hemi.intensity = k.hemi * 0.72 * dim;
    this.hemi.diffuse = new Color3(0.95, 0.97, 1);
    this.hemi.groundColor = new Color3(k.ground[0] * 1.4, k.ground[1] * 1.4, k.ground[2] * 1.4);

    this.sunDisc.position.copyFrom(sunDir.scale(600));
    this.sunDisc.setEnabled(sunDir.y > -0.1);
    this.moonDisc.position.copyFrom(sunDir.scale(-600));
    this.moonDisc.setEnabled(sunDir.y < 0.1);

    const night = hour < 5.5 || hour > 19.2;
    this.lantern.intensity = night ? 0.7 : 0;
    this.lantern.position.set(focus.x, focus.y + 2.2, focus.z);

    // Clouds drift and wrap around the focus point
    const buf = new Float32Array(this.cloudOffsets.length / 3 * 16);
    const m = new Matrix();
    const t = performance.now() / 1000;
    for (let i = 0; i < this.cloudOffsets.length / 3; i++) {
      let x = this.cloudOffsets[i * 3] + t * 1.6;
      let z = this.cloudOffsets[i * 3 + 2];
      x = ((((x - focus.x) % 900) + 1350) % 900) - 450 + focus.x;
      z = ((((z - focus.z) % 900) + 1350) % 900) - 450 + focus.z;
      const sx = 16 + hash2(i, 4, 9) * 30;
      const sz = 12 + hash2(i, 5, 9) * 22;
      Matrix.ComposeToRef(new Vector3(Math.round(sx / 4) * 4, 4, Math.round(sz / 4) * 4), Quaternion.Identity(), new Vector3(Math.round(x / 4) * 4, this.cloudOffsets[i * 3 + 1], Math.round(z / 4) * 4), m);
      m.copyToArray(buf, i * 16);
    }
    this.clouds.thinInstanceSetBuffer("matrix", buf, 16, false);
    const cm = this.clouds.material as StandardMaterial;
    cm.emissiveColor = new Color3(0.25 + k.hemi * 0.5, 0.25 + k.hemi * 0.5, 0.3 + k.hemi * 0.5);

    this.updateRain(rain, cameraPos);
    void dt;
  }

  private updateRain(on: boolean, cameraPos: Vector3): void {
    if (on && !this.rain && this.particleBudget > 0) {
      const tex = new DynamicTexture("rainTex", { width: 4, height: 32 }, this.scene, false);
      const g = tex.getContext() as CanvasRenderingContext2D;
      const grad = g.createLinearGradient(0, 0, 0, 32);
      grad.addColorStop(0, "rgba(200,220,255,0)");
      grad.addColorStop(1, "rgba(200,220,255,0.9)");
      g.fillStyle = grad;
      g.fillRect(1, 0, 2, 32);
      tex.hasAlpha = true;
      tex.update();
      const ps = new ParticleSystem("rain", clamp(Math.floor(this.particleBudget * 0.7), 50, 1500), this.scene);
      ps.particleTexture = tex;
      ps.emitter = cameraPos.clone();
      ps.minEmitBox = new Vector3(-18, 12, -18);
      ps.maxEmitBox = new Vector3(18, 16, 18);
      ps.direction1 = new Vector3(-0.5, -26, -0.3);
      ps.direction2 = new Vector3(0.5, -30, 0.3);
      ps.minSize = 0.12;
      ps.maxSize = 0.2;
      ps.minScaleY = 6;
      ps.maxScaleY = 8;
      ps.minLifeTime = 0.6;
      ps.maxLifeTime = 0.8;
      ps.emitRate = ps.getCapacity() * 1.4;
      ps.billboardMode = ParticleSystem.BILLBOARDMODE_Y;
      ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
      ps.start();
      this.rain = ps;
    } else if (!on && this.rain) {
      this.rain.stop();
      this.rain.dispose();
      this.rain = null;
    }
    if (this.rain) (this.rain.emitter as Vector3).copyFrom(cameraPos);
  }
}
