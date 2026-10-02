import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { clamp, lerp, lerpAngle } from "@shared/math/vec";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { Controls } from "./Input";

/**
 * Third-person orbit camera with voxel collision, an over-the-shoulder aim
 * mode for throwing Poké Balls, a gentle "look at the ball" assist, and a
 * battle framing mode. A small trauma value adds screen shake.
 */
export class CameraRig {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.35;
  distance = 7;
  /** 0 = orbit, 1 = aim (over the right shoulder). */
  aimBlend = 0;
  aiming = false;
  /** Point the camera drifts toward a little (thrown ball), or null. */
  assist: Vector3 | null = null;
  private trauma = 0;
  private battle: { a: Vector3; b: Vector3 } | null = null;
  private readonly current = new Vector3();
  private readonly lookAt = new Vector3();
  private initialized = false;

  constructor(scene: Scene) {
    this.camera = new FreeCamera("camera", new Vector3(0, 90, -10), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1400;
    this.camera.fov = 0.95;
  }

  setBattle(a: Vector3 | null, b?: Vector3): void {
    this.battle = a && b ? { a: a.clone(), b: b.clone() } : null;
  }

  get inBattle(): boolean {
    return this.battle !== null;
  }

  snap(): void {
    this.initialized = false;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Direction the camera looks (unit vector). */
  forward(): Vector3 {
    return this.camera.getForwardRay(1).direction.clone();
  }

  private collide(world: VoxelWorld, from: Vector3, to: Vector3): Vector3 {
    const d = to.subtract(from);
    const len = d.length();
    if (len < 0.01) return to;
    const hit = world.raycast(from.x, from.y, from.z, d.x, d.y, d.z, len + 0.3);
    if (!hit) return to;
    const t = Math.max(0.6, hit.dist - 0.3) / len;
    return from.add(d.scale(Math.min(1, t)));
  }

  update(dt: number, focus: Vector3, controls: Controls, world: VoxelWorld): void {
    if (this.battle && !this.aiming) {
      const { a, b } = this.battle;
      const mid = a.add(b).scale(0.5);
      const ab = b.subtract(a);
      const span = Math.max(4, ab.length());
      // Side-on view, slightly behind the player's Pokémon
      const side = new Vector3(-ab.z, 0, ab.x).normalize();
      const back = ab.normalize().scale(-0.55 * span);
      let target = mid.add(side.scale(span * 0.85)).add(back).add(new Vector3(0, span * 0.42 + 1.2, 0));
      target = this.collide(world, mid.add(new Vector3(0, 1.2, 0)), target);
      const k = Math.min(1, dt * 3);
      this.current.copyFrom(Vector3.Lerp(this.current, target, k));
      this.lookAt.copyFrom(Vector3.Lerp(this.lookAt, mid.add(new Vector3(0, 0.8, 0)), k));
      this.apply(dt);
      return;
    }

    this.yaw += controls.look.dx * 0.0042 * (this.aiming ? 0.7 : 1);
    this.pitch = clamp(this.pitch + controls.look.dy * 0.0036 * (this.aiming ? 0.7 : 1), -0.75, 1.3);
    if (!this.aiming) this.distance = clamp(this.distance + controls.zoom * 0.8, 2.5, 16);
    this.aimBlend += ((this.aiming ? 1 : 0) - this.aimBlend) * Math.min(1, dt * 10);

    // Mild assist: drift toward a thrown ball without taking control away
    if (this.assist && !this.aiming) {
      const to = this.assist.subtract(focus);
      const want = Math.atan2(to.x, to.z);
      this.yaw = lerpAngle(this.yaw, want, Math.min(1, dt * 0.9));
    }

    const ab = this.aimBlend;
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const target = focus.add(new Vector3(0, lerp(1.55, 1.65, ab), 0)).add(right.scale(0.85 * ab));
    const d = lerp(this.distance, 3.1, ab);
    const dir = new Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const pos = this.collide(world, target, target.add(dir.scale(d)));

    if (!this.initialized) {
      this.current.copyFrom(pos);
      this.lookAt.copyFrom(target);
      this.initialized = true;
    } else {
      const k = Math.min(1, dt * (this.aiming ? 22 : 14));
      this.current.copyFrom(Vector3.Lerp(this.current, pos, k));
      this.lookAt.copyFrom(Vector3.Lerp(this.lookAt, target, Math.min(1, dt * 24)));
    }
    this.apply(dt);
  }

  private apply(dt: number): void {
    this.camera.position.copyFrom(this.current);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * 0.12;
      const t = performance.now() / 1000;
      this.camera.position.addInPlace(new Vector3(Math.sin(t * 61) * s, Math.sin(t * 53 + 1) * s, Math.sin(t * 47 + 2) * s));
      this.trauma = Math.max(0, this.trauma - dt * 1.8);
    }
    this.camera.setTarget(this.lookAt);
  }

  /** Smoothly turns the camera behind a heading (used after teleports). */
  faceHeading(rotY: number, t = 1): void {
    this.yaw = lerpAngle(this.yaw, rotY, t);
    this.pitch = lerp(this.pitch, 0.35, t);
  }
}
