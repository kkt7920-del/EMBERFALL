import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MOVE } from "@shared/config/constants";
import { lerpAngle } from "@shared/math/vec";
import type { MountMode } from "@shared/types/content";
import type { AnimState } from "@shared/types/game";
import { Block } from "@shared/world/blocks";
import { type Body, bodyBlocked, moveBody, onGround, unstick } from "@shared/world/physics";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { Controls } from "./Input";

/**
 * Local player movement (client-side prediction) with voxel collision:
 * walking with auto-step, jumping, swimming at the surface, diving, and
 * flying on a mount. The server validates the result and corrects us if we
 * ever disagree.
 */
export class PlayerController {
  readonly pos = new Vector3();
  rotY = 0;
  velY = 0;
  onGround = true;
  anim: AnimState = "idle";
  mountModes: MountMode[] = [];
  mountSpeed = 1;
  /** Head under water. */
  submerged = false;
  inWater = false;
  /** Faces the camera direction while aiming instead of the movement direction. */
  strafe = false;
  private moving = false;
  private readonly body: Body = { x: 0, y: 0, z: 0, halfW: MOVE.radius, height: MOVE.height };

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

  update(dt: number, c: Controls, yaw: number, world: VoxelWorld): void {
    const p = this.pos;
    const b = this.body;
    b.x = p.x;
    b.y = p.y;
    b.z = p.z;
    if (bodyBlocked(world, b)) unstick(world, b, 4);

    const water = (y: number) => world.block(b.x, y, b.z) === Block.WATER;
    this.inWater = water(b.y + 0.9);
    this.submerged = water(b.y + 1.6);
    const swimMount = this.mountModes.includes("swim");
    const swimming = !this.flying && this.inWater;
    const airborneFly = this.flying && !this.onGround;

    // Speed for the current medium
    let speed: number = c.run ? MOVE.run : MOVE.walk;
    if (swimming) speed = swimMount ? MOVE.run * this.mountSpeed * 1.1 : MOVE.swim * (c.run ? 1.3 : 1);
    else if (airborneFly) speed = MOVE.fly * this.mountSpeed * (c.run ? 1.25 : 1);
    else if (this.mounted) speed = MOVE.run * this.mountSpeed * (c.run ? 1.15 : 0.9);
    if (this.strafe && !this.mounted) speed *= 0.75;

    // Horizontal movement relative to the camera
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const mx = c.move.x * fz + c.move.y * fx;
    const mz = -c.move.x * fx + c.move.y * fz;
    const mag = Math.min(1, Math.hypot(mx, mz));
    this.moving = mag > 0.05;

    if (this.moving) {
      const step = speed * dt;
      const res = moveBody(world, b, mx * step, 0, mz * step, airborneFly ? 0 : this.onGround || swimming ? MOVE.stepHeight : 0);
      // Climb out of water onto a ledge
      if (swimming && (res.hitX || res.hitZ) && !this.submerged) {
        const lift = { ...b };
        lift.y = Math.floor(b.y) + 1.05;
        if (!bodyBlocked(world, lift, lift.x + mx * 0.4, lift.y, lift.z + mz * 0.4)) {
          b.y = lift.y;
          moveBody(world, b, mx * 0.4, 0, mz * 0.4, 0);
        }
      }
    }
    if (this.strafe) this.rotY = lerpAngle(this.rotY, yaw, Math.min(1, dt * 16));
    else if (this.moving) this.rotY = lerpAngle(this.rotY, Math.atan2(mx, mz), Math.min(1, dt * 12));

    // Vertical
    if (this.flying) {
      if (c.jumpHeld) this.velY = 8;
      else if (c.descendHeld) this.velY = -9;
      else if (!this.onGround) this.velY = Math.max(this.velY - 10 * dt, -2.5);
      else this.velY = 0;
      if (this.inWater && this.velY < 0) this.velY = 0;
      const r = moveBody(world, b, 0, this.velY * dt, 0);
      if (r.hitY && this.velY < 0) {
        this.velY = 0;
        this.onGround = true;
      } else this.onGround = onGround(world, b);
      if (b.y > 250) b.y = 250;
    } else if (swimming) {
      this.onGround = false;
      if (swimMount) {
        // Ride on the surface
        let surface = b.y;
        while (water(surface + 1.2)) surface += 1;
        const target = Math.floor(surface + 1.2) - 0.55;
        b.y += (target - b.y) * Math.min(1, dt * 6);
        this.velY = 0;
      } else {
        if (c.jumpHeld) this.velY = Math.min(this.velY + 14 * dt, 3.2);
        else if (c.descendHeld) this.velY = Math.max(this.velY - 14 * dt, -3.2);
        else {
          // Float up to the surface, bob with the head above water
          const target = this.submerged ? 1.6 : water(b.y + 1.35) ? 0.6 : -0.6;
          this.velY += (target - this.velY) * Math.min(1, dt * 3);
        }
        const r = moveBody(world, b, 0, this.velY * dt, 0);
        if (r.hitY) this.velY = 0;
        if (c.pressed.has("jump") && !this.submerged) this.velY = 5.5;
      }
    } else {
      if (this.onGround && c.pressed.has("jump")) {
        this.velY = MOVE.jumpVelocity * (this.mounted ? 1.1 : 1);
        this.onGround = false;
      }
      this.velY = Math.max(this.velY - MOVE.gravity * dt, -55);
      const r = moveBody(world, b, 0, this.velY * dt, 0);
      if (r.hitY) {
        if (this.velY < 0) this.onGround = true;
        this.velY = 0;
      } else this.onGround = this.velY <= 0 && onGround(world, b);
    }

    p.set(b.x, b.y, b.z);
    const nowWater = !this.flying && world.block(b.x, b.y + 0.9, b.z) === Block.WATER;
    const under = nowWater && world.block(b.x, b.y + 1.6, b.z) === Block.WATER;
    if (nowWater) this.anim = under && !swimMount ? "dive" : "swim";
    else if (this.flying && !this.onGround) this.anim = "fly";
    else if (!this.onGround) this.anim = "jump";
    else if (this.moving) this.anim = c.run || this.mounted ? "run" : "walk";
    else this.anim = "idle";
  }
}
