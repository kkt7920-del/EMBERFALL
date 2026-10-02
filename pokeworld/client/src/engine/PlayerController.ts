import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MOVE } from "@shared/config/constants";
import { lerpAngle } from "@shared/math/vec";
import type { MountMode } from "@shared/types/content";
import type { AnimState } from "@shared/types/game";
import type { ClientTerrain } from "../world/ClientTerrain";
import type { Controls } from "./Input";

/**
 * Local player movement (client-side prediction). Uses the same voxel
 * heightmap and limits the server validates against; the server corrects us
 * if we ever disagree.
 */
export class PlayerController {
  readonly pos = new Vector3();
  rotY = 0;
  velY = 0;
  onGround = true;
  anim: AnimState = "idle";
  mountModes: MountMode[] = [];
  mountSpeed = 1;
  private moving = false;

  teleport(x: number, y: number, z: number, rotY?: number): void {
    this.pos.set(x, y, z);
    this.velY = 0;
    this.onGround = true;
    if (rotY !== undefined) this.rotY = rotY;
  }

  get mounted(): boolean {
    return this.mountModes.length > 0;
  }

  get flying(): boolean {
    return this.mountModes.includes("fly");
  }

  update(dt: number, c: Controls, yaw: number, terrain: ClientTerrain, zone: string): void {
    const R = MOVE.radius;
    const level = terrain.waterLevel(zone);
    const ceiling = terrain.ceiling(zone);
    const bounds = terrain.bounds(zone);
    const p = this.pos;

    const columnHere = terrain.height(zone, p.x, p.z);
    const depthHere = level === null ? 0 : level - columnHere;
    const swimMount = this.mountModes.includes("swim");
    const inWater = !this.flying && level !== null && depthHere > 0.9 && p.y < level - 0.2;

    // Speed for the current medium
    let speed: number = c.run ? MOVE.run : MOVE.walk;
    if (inWater) speed = swimMount ? MOVE.run * this.mountSpeed * 1.1 : MOVE.swim;
    else if (this.flying && !this.onGround) speed = MOVE.fly * this.mountSpeed * (c.run ? 1.25 : 1);
    else if (this.mounted) speed = MOVE.run * this.mountSpeed * (c.run ? 1.15 : 0.9);

    // Horizontal movement relative to the camera
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const mx = c.move.x * fz + c.move.y * fx;
    const mz = -c.move.x * fx + c.move.y * fz;
    const mag = Math.min(1, Math.hypot(mx, mz));
    this.moving = mag > 0.05;

    const airborneFly = this.flying && !this.onGround;
    const blocked = (g: number) => (airborneFly ? g > p.y + 0.05 : g - p.y > MOVE.stepHeight);
    const inside = (x: number, z: number) => !bounds || (x > bounds.minX + 1 && z > bounds.minZ + 1 && x < bounds.maxX - 1 && z < bounds.maxZ - 1);

    if (this.moving) {
      const step = speed * dt;
      const nx = p.x + mx * step;
      if (inside(nx, p.z) && !blocked(terrain.ground(zone, nx, p.z, R))) p.x = nx;
      const nz = p.z + mz * step;
      if (inside(p.x, nz) && !blocked(terrain.ground(zone, p.x, nz, R))) p.z = nz;
      this.rotY = lerpAngle(this.rotY, Math.atan2(mx, mz), Math.min(1, dt * 12));
    }

    const ground = terrain.ground(zone, p.x, p.z, R);

    if (this.flying) {
      if (c.jumpHeld) this.velY = 8;
      else if (c.descendHeld) this.velY = -9;
      else if (!this.onGround) this.velY = Math.max(this.velY - 10 * dt, -2.5);
      else this.velY = 0;
      p.y += this.velY * dt;
      if (p.y <= ground) {
        p.y = ground;
        this.velY = 0;
        this.onGround = true;
      } else this.onGround = false;
      if (level !== null && p.y < level - 0.2 && depthHere > 0.5) p.y = level - 0.2;
      p.y = Math.min(p.y, 120);
    } else if (inWater) {
      const surface = swimMount ? level! - 0.35 : level! - 1.05;
      p.y += (surface - p.y) * Math.min(1, dt * 6);
      this.velY = 0;
      this.onGround = false;
      // Climb out onto a ledge
      if (c.pressed.has("jump") || (this.moving && ground > p.y && ground - p.y < 1.6)) {
        if (ground - p.y < 1.6 && ground > surface) {
          p.y = ground;
          this.onGround = true;
        } else if (c.pressed.has("jump")) this.velY = 5;
      }
    } else {
      if (this.onGround && c.pressed.has("jump")) {
        this.velY = MOVE.jumpVelocity * (this.mounted ? 1.1 : 1);
        this.onGround = false;
      }
      this.velY -= MOVE.gravity * dt;
      p.y += this.velY * dt;
      if (p.y <= ground) {
        p.y = ground;
        this.velY = 0;
        this.onGround = true;
      } else if (this.onGround && p.y - ground < 0.6 && this.velY <= 0) {
        // Stick to the ground walking down steps
        p.y = ground;
        this.velY = 0;
      } else {
        this.onGround = false;
      }
    }

    if (ceiling !== null && p.y + MOVE.height > ceiling) {
      p.y = ceiling - MOVE.height;
      this.velY = Math.min(0, this.velY);
    }

    const nowInWater = !this.flying && level !== null && level - terrain.height(zone, p.x, p.z) > 0.9 && p.y < level - 0.2;
    if (nowInWater) this.anim = "swim";
    else if (this.flying && !this.onGround) this.anim = "fly";
    else if (!this.onGround) this.anim = "jump";
    else if (this.moving) this.anim = c.run || this.mounted ? "run" : "walk";
    else this.anim = "idle";
  }
}
