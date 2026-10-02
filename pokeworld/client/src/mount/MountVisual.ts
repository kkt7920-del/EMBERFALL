import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { lerpAngle } from "@shared/math/vec";
import type { AnimState, CreatureAnim } from "@shared/types/game";
import type { CreatureLibrary, CreatureView } from "../pokemon/CreatureLibrary";
import type { ClientTerrain } from "../world/ClientTerrain";

const ANIM: Record<AnimState, CreatureAnim> = { idle: "idle", walk: "walk", run: "run", swim: "swim", fly: "fly", jump: "run" };

/**
 * Riding and following. The ridden creature is drawn under the trainer; the
 * lead creature otherwise trots behind them ("travel with your partner").
 */
export class Companion {
  private view: CreatureView | null = null;
  private species: string | null = null;
  private mode: "follow" | "mount" = "follow";

  constructor(
    private readonly lib: CreatureLibrary,
    private readonly terrain: ClientTerrain,
  ) {}

  /** Seat height for the rider above the ground. */
  get seat(): number {
    return this.mode === "mount" && this.view ? 0.62 * this.view.scale : 0;
  }

  set(species: string | null, mode: "follow" | "mount"): void {
    if (species === this.species && mode === this.mode) return;
    if (this.view && species !== this.species) {
      this.lib.release(this.view);
      this.view = null;
    }
    this.species = species;
    this.mode = mode;
    if (species && !this.view) this.view = this.lib.acquire(species);
  }

  hide(on: boolean): void {
    this.view?.setVisible(!on);
  }

  get current(): CreatureView | null {
    return this.view;
  }

  update(dt: number, zone: string, player: Vector3, rotY: number, anim: AnimState): void {
    const v = this.view;
    if (!v) return;
    const level = this.terrain.waterLevel(zone);
    if (this.mode === "mount") {
      v.root.position.copyFrom(player);
      v.root.rotation.y = rotY;
      v.anim = ANIM[anim];
      v.update(dt, Math.max(this.terrain.height(zone, player.x, player.z), level ?? -Infinity));
      return;
    }

    const flyer = v.species.behavior.movement.includes("fly") && !v.species.behavior.movement.includes("walk");
    const behind = new Vector3(player.x - Math.sin(rotY) * 2 + Math.cos(rotY) * 0.9, 0, player.z - Math.cos(rotY) * 2 - Math.sin(rotY) * 0.9);
    const pos = v.root.position;
    const d = Vector3.Distance(new Vector3(pos.x, 0, pos.z), new Vector3(behind.x, 0, behind.z));
    if (d > 25 || pos.lengthSquared() === 0) pos.set(behind.x, player.y, behind.z);

    let moving = false;
    if (d > 0.6) {
      const speed = Math.min(12, 2 + d * 2.2);
      const step = Math.min(d, speed * dt);
      const dx = (behind.x - pos.x) / d;
      const dz = (behind.z - pos.z) / d;
      pos.x += dx * step;
      pos.z += dz * step;
      v.root.rotation.y = lerpAngle(v.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 10));
      moving = true;
    } else {
      v.root.rotation.y = lerpAngle(v.root.rotation.y, rotY, Math.min(1, dt * 3));
    }

    const ground = this.terrain.ground(zone, pos.x, pos.z, 0.3);
    const water = level !== null && level - this.terrain.height(zone, pos.x, pos.z) > 0.8;
    if (flyer) {
      pos.y += (Math.max(ground, level ?? ground) + 1.6 - pos.y) * Math.min(1, dt * 5);
      v.anim = "fly";
    } else if (water) {
      pos.y += (level! - 0.45 - pos.y) * Math.min(1, dt * 6);
      v.anim = "swim";
    } else {
      pos.y += (ground - pos.y) * Math.min(1, dt * 12);
      v.anim = moving ? (d > 3 ? "run" : "walk") : "idle";
    }
    v.update(dt, Math.max(ground, level ?? -Infinity));
  }

  dispose(): void {
    if (this.view) this.lib.release(this.view);
    this.view = null;
    this.species = null;
  }
}
