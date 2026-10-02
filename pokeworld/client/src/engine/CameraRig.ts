import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import { clamp, lerp, lerpAngle } from "@shared/math/vec";
import type { ClientTerrain } from "../world/ClientTerrain";
import type { Controls } from "./Input";

/** Third-person orbit camera with terrain collision and a battle framing mode. */
export class CameraRig {
  readonly camera: FreeCamera;
  yaw = 0;
  pitch = 0.35;
  distance = 7;
  private battle: { a: Vector3; b: Vector3 } | null = null;
  private readonly current = new Vector3();
  private readonly lookAt = new Vector3();
  private initialized = false;

  constructor(scene: Scene) {
    this.camera = new FreeCamera("camera", new Vector3(0, 30, -10), scene);
    this.camera.inputs.clear();
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1000;
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

  /** Horizontal forward direction of the camera (for movement). */
  forward(): { x: number; z: number } {
    return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
  }

  update(dt: number, focus: Vector3, controls: Controls, terrain: ClientTerrain, zone: string): void {
    const ceiling = terrain.ceiling(zone);

    if (this.battle) {
      const { a, b } = this.battle;
      const mid = a.add(b).scale(0.5);
      const ab = b.subtract(a);
      const span = Math.max(4, ab.length());
      // Side-on view, slightly behind the player's creature
      const side = new Vector3(-ab.z, 0, ab.x).normalize();
      const back = ab.normalize().scale(-0.55 * span);
      let target = mid.add(side.scale(span * 0.85)).add(back).add(new Vector3(0, span * 0.42 + 1.2, 0));
      if (ceiling !== null) target.y = Math.min(target.y, ceiling - 0.8);
      const groundAtCam = terrain.height(zone, target.x, target.z) + 1;
      if (target.y < groundAtCam) target = new Vector3(target.x, groundAtCam, target.z);
      const k = Math.min(1, dt * 3);
      this.current.copyFrom(Vector3.Lerp(this.current, target, k));
      this.lookAt.copyFrom(Vector3.Lerp(this.lookAt, mid.add(new Vector3(0, 0.8, 0)), k));
      this.camera.position.copyFrom(this.current);
      this.camera.setTarget(this.lookAt);
      return;
    }

    this.yaw += controls.look.dx * 0.0042;
    this.pitch = clamp(this.pitch + controls.look.dy * 0.0036, -0.35, 1.25);
    this.distance = clamp(this.distance + controls.zoom * 0.8, 2.5, 16);

    const target = focus.add(new Vector3(0, 1.55, 0));
    let d = this.distance;
    const dir = new Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));

    // Pull in when terrain blocks the view
    for (let i = 1; i <= 8; i++) {
      const p = target.add(dir.scale((d * i) / 8));
      const g = terrain.height(zone, p.x, p.z) + 0.35;
      if (p.y < g || (ceiling !== null && p.y > ceiling - 0.4)) {
        d = Math.max(1.2, (d * (i - 1)) / 8);
        break;
      }
    }
    const pos = target.add(dir.scale(d));
    if (ceiling !== null) pos.y = Math.min(pos.y, ceiling - 0.5);
    pos.y = Math.max(pos.y, terrain.height(zone, pos.x, pos.z) + 0.4);

    if (!this.initialized) {
      this.current.copyFrom(pos);
      this.lookAt.copyFrom(target);
      this.initialized = true;
    } else {
      const k = Math.min(1, dt * 14);
      this.current.copyFrom(Vector3.Lerp(this.current, pos, k));
      this.lookAt.copyFrom(Vector3.Lerp(this.lookAt, target, Math.min(1, dt * 20)));
    }
    this.camera.position.copyFrom(this.current);
    this.camera.setTarget(this.lookAt);
  }

  /** Smoothly turns the camera behind a heading (used after teleports). */
  faceHeading(rotY: number, t = 1): void {
    this.yaw = lerpAngle(this.yaw, rotY, t);
    this.pitch = lerp(this.pitch, 0.35, t);
  }
}
