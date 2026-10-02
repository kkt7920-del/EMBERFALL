import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import "@babylonjs/core/Particles/particleSystemComponent";
import type { Scene } from "@babylonjs/core/scene";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Battle and capture effects under a global particle budget: one burst
 * system is reused for every hit, sized from the quality setting.
 */
export class Effects {
  private burst: ParticleSystem;
  private readonly orbMesh: Mesh;
  private readonly orbMat: StandardMaterial;
  private readonly bolt: Mesh;
  private readonly boltMat: StandardMaterial;
  private readonly ring: Mesh;
  private readonly ringMat: StandardMaterial;
  private readonly sparkTex: DynamicTexture;

  constructor(
    private readonly scene: Scene,
    private budget: number,
  ) {
    this.sparkTex = new DynamicTexture("spark", { width: 32, height: 32 }, scene, false);
    const g = this.sparkTex.getContext() as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 15);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    this.sparkTex.hasAlpha = true;
    this.sparkTex.update();
    this.burst = this.makeBurst();

    this.orbMat = new StandardMaterial("orbMat", scene);
    this.orbMat.diffuseColor = new Color3(0.9, 0.25, 0.25);
    this.orbMat.specularColor = new Color3(1, 1, 1);
    this.orbMesh = CreateSphere("orb", { diameter: 0.32, segments: 8 }, scene);
    this.orbMesh.material = this.orbMat;
    this.orbMesh.isPickable = false;
    this.orbMesh.setEnabled(false);

    this.boltMat = new StandardMaterial("boltMat", scene);
    this.boltMat.disableLighting = true;
    this.bolt = CreateSphere("bolt", { diameter: 0.45, segments: 6 }, scene);
    this.bolt.material = this.boltMat;
    this.bolt.isPickable = false;
    this.bolt.setEnabled(false);

    this.ringMat = new StandardMaterial("ringMat", scene);
    this.ringMat.disableLighting = true;
    this.ringMat.alpha = 0.7;
    this.ring = CreateTorus("ring", { diameter: 1, thickness: 0.08, tessellation: 24 }, scene);
    this.ring.material = this.ringMat;
    this.ring.isPickable = false;
    this.ring.setEnabled(false);
  }

  private makeBurst(): ParticleSystem {
    const ps = new ParticleSystem("burst", Math.max(16, Math.min(200, Math.floor(this.budget * 0.25))), this.scene);
    ps.particleTexture = this.sparkTex;
    ps.emitter = Vector3.Zero();
    ps.minEmitPower = 2;
    ps.maxEmitPower = 5;
    ps.minLifeTime = 0.25;
    ps.maxLifeTime = 0.55;
    ps.minSize = 0.12;
    ps.maxSize = 0.3;
    ps.direction1 = new Vector3(-1, 1, -1);
    ps.direction2 = new Vector3(1, 2, 1);
    ps.gravity = new Vector3(0, -6, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.emitRate = 0;
    ps.manualEmitCount = 0;
    ps.start();
    return ps;
  }

  setBudget(n: number): void {
    this.budget = n;
    this.burst.dispose();
    this.burst = this.makeBurst();
  }

  sparks(at: Vector3, color: string, count = 24): void {
    const c = Color3.FromHexString(color);
    this.burst.color1 = new Color4(c.r, c.g, c.b, 1);
    this.burst.color2 = new Color4(1, 1, 1, 1);
    this.burst.colorDead = new Color4(c.r, c.g, c.b, 0);
    (this.burst.emitter as Vector3).copyFrom(at);
    this.burst.manualEmitCount = Math.min(count, this.burst.getCapacity());
  }

  async projectile(from: Vector3, to: Vector3, color: string): Promise<void> {
    this.boltMat.emissiveColor = Color3.FromHexString(color);
    this.bolt.setEnabled(true);
    const t0 = performance.now();
    const dur = 320;
    await new Promise<void>((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        this.bolt.position.copyFrom(Vector3.Lerp(from, to, k));
        this.bolt.position.y += Math.sin(k * Math.PI) * 0.6;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
    this.bolt.setEnabled(false);
    this.sparks(to, color, 30);
  }

  async aura(at: Vector3, color: string): Promise<void> {
    this.ringMat.emissiveColor = Color3.FromHexString(color);
    this.ring.setEnabled(true);
    this.ring.position.copyFrom(at);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 450);
        this.ring.scaling.setAll(0.5 + k * 2.2);
        this.ringMat.alpha = 0.8 * (1 - k);
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
    this.ring.setEnabled(false);
  }

  /** Arcs a capture orb from the thrower to the target. */
  async throwOrb(from: Vector3, to: Vector3, color: string): Promise<void> {
    this.orbMat.diffuseColor = Color3.FromHexString(color);
    this.orbMesh.setEnabled(true);
    const t0 = performance.now();
    const dur = 520;
    const height = 1.5 + Vector3.Distance(from, to) * 0.12;
    await new Promise<void>((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        this.orbMesh.position.copyFrom(Vector3.Lerp(from, to, k));
        this.orbMesh.position.y += Math.sin(k * Math.PI) * height;
        this.orbMesh.rotation.x += 0.4;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      };
      step();
    });
    this.sparks(to, "#ffffff", 20);
  }

  /** Orb sits on the ground and wobbles `shakes` times. */
  async shakeOrb(at: Vector3, shakes: number): Promise<void> {
    this.orbMesh.position.copyFrom(at);
    this.orbMesh.rotation.set(0, 0, 0);
    await wait(250);
    for (let i = 0; i < shakes; i++) {
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / 420);
          this.orbMesh.rotation.z = Math.sin(k * Math.PI * 2) * 0.45;
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        step();
      });
      await wait(260);
    }
  }

  hideOrb(success: boolean): void {
    if (success) this.sparks(this.orbMesh.position.clone(), "#ffde59", 40);
    else this.sparks(this.orbMesh.position.clone(), "#ffffff", 16);
    this.orbMesh.setEnabled(false);
  }
}
