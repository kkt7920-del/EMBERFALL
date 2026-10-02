import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { lerpAngle } from "@shared/math/vec";
import type { AnimState, CreatureAnim } from "@shared/types/game";
import { Block } from "@shared/world/blocks";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { PokemonLibrary } from "../pokemon/PokemonLibrary";
import type { PokemonView } from "../pokemon/PokemonView";

const ANIM: Record<AnimState, CreatureAnim> = { idle: "idle", walk: "walk", run: "run", swim: "swim", dive: "swim", fly: "fly", jump: "run" };

/**
 * Riding and following. The ridden Pokémon is drawn under the trainer;
 * otherwise the lead Pokémon walks behind them in the world.
 */
export class Companion {
  private view: PokemonView | null = null;
  private species: string | null = null;
  private mode: "follow" | "mount" = "follow";
  private size = 1;

  constructor(
    private readonly lib: PokemonLibrary,
    private readonly world: VoxelWorld,
  ) {}

  /** Seat height for the rider above the ground. */
  get seat(): number {
    return this.mode === "mount" && this.view ? Math.max(0.5, this.view.height * 0.62) : 0;
  }

  set(species: string | null, mode: "follow" | "mount", size = 1): void {
    if (species === this.species && mode === this.mode && size === this.size) return;
    if (this.view && (species !== this.species || size !== this.size)) {
      this.lib.release(this.view);
      this.view = null;
    }
    this.species = species;
    this.mode = mode;
    this.size = size;
    if (species && !this.view) this.view = this.lib.acquire(species, { size });
  }

  hide(on: boolean): void {
    this.view?.setVisible(!on);
  }

  get current(): PokemonView | null {
    return this.view;
  }

  update(dt: number, player: Vector3, rotY: number, anim: AnimState): void {
    const v = this.view;
    if (!v) return;
    if (this.mode === "mount") {
      v.root.position.copyFrom(player);
      v.root.rotation.y = rotY;
      v.anim = ANIM[anim];
      v.mode = anim === "fly" ? "fly" : anim === "swim" ? "swim" : "walk";
      v.update(dt);
      return;
    }

    const sp = v.species.movement;
    const flyer = sp.air && !sp.land;
    const back = 1.4 + v.width;
    const behind = new Vector3(player.x - Math.sin(rotY) * back + Math.cos(rotY) * 0.9, 0, player.z - Math.cos(rotY) * back - Math.sin(rotY) * 0.9);
    const pos = v.root.position;
    const d = Math.hypot(pos.x - behind.x, pos.z - behind.z);
    if (d > 24 || pos.lengthSquared() === 0 || Math.abs(pos.y - player.y) > 12) pos.set(behind.x, player.y, behind.z);

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

    const floor = this.world.floorNear(pos.x, Math.max(pos.y, player.y) + 1, pos.z, 1, 2, 10) ?? player.y;
    const water = this.world.block(pos.x, floor + 0.2, pos.z) === Block.WATER;
    if (flyer) {
      pos.y += (floor + 1.6 - pos.y) * Math.min(1, dt * 5);
      v.anim = "fly";
      v.mode = "fly";
    } else if (water && sp.water) {
      let surface = floor;
      while (this.world.block(pos.x, surface + 1, pos.z) === Block.WATER) surface++;
      pos.y += (surface + 0.5 - pos.y) * Math.min(1, dt * 6);
      v.anim = moving ? "swim" : "idle";
      v.mode = "swim";
    } else {
      pos.y += (floor - pos.y) * Math.min(1, dt * 12);
      v.anim = moving ? (d > 3 ? "run" : "walk") : "idle";
      v.mode = "walk";
    }
    v.update(dt);
  }

  dispose(): void {
    if (this.view) this.lib.release(this.view);
    this.view = null;
    this.species = null;
  }
}
