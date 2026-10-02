import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { lerpAngle } from "@shared/math/vec";
import type { CreatureMove } from "@shared/protocol/messages";
import type { WildSnapshot } from "@shared/types/game";
import type { ClientTerrain } from "../world/ClientTerrain";
import type { CreatureLibrary, CreatureView } from "./CreatureLibrary";

export interface WildEntity {
  snap: WildSnapshot;
  view: CreatureView;
  target: Vector3;
  rotTarget: number;
  /** Hidden while inside a thrown capture orb. */
  held: boolean;
  /** Owned by the battle staging (do not interpolate/cull). */
  pinned: boolean;
}

/** Replicated wild creatures: smoothing between 10 Hz server updates, distance culling, pooling. */
export class CreatureManager {
  private readonly wild = new Map<string, WildEntity>();

  constructor(
    private readonly lib: CreatureLibrary,
    private readonly terrain: ClientTerrain,
    private readonly zone: () => string,
  ) {}

  spawn(list: WildSnapshot[]): void {
    for (const s of list) {
      if (this.wild.has(s.id)) continue;
      const view = this.lib.acquire(s.species);
      view.root.position.set(s.x, s.y, s.z);
      view.root.rotation.y = s.rotY;
      view.anim = s.anim;
      this.wild.set(s.id, { snap: s, view, target: new Vector3(s.x, s.y, s.z), rotTarget: s.rotY, held: false, pinned: false });
    }
  }

  move(list: CreatureMove[]): void {
    for (const m of list) {
      const w = this.wild.get(m.id);
      if (!w) continue;
      w.target.set(m.x, m.y, m.z);
      w.rotTarget = m.rotY;
      if (!w.pinned || m.anim === "battle") w.view.anim = m.anim;
      w.snap = { ...w.snap, x: m.x, y: m.y, z: m.z, rotY: m.rotY, anim: m.anim };
    }
  }

  despawn(ids: string[], reason?: string): void {
    for (const id of ids) {
      const w = this.wild.get(id);
      if (!w) continue;
      this.wild.delete(id);
      if (reason === "defeated") {
        w.view.playFaint();
        setTimeout(() => this.lib.release(w.view), 1100);
      } else {
        this.lib.release(w.view);
      }
    }
  }

  clear(): void {
    for (const w of this.wild.values()) this.lib.release(w.view);
    this.wild.clear();
  }

  get(id: string): WildEntity | undefined {
    return this.wild.get(id);
  }

  all(): IterableIterator<WildEntity> {
    return this.wild.values();
  }

  get count(): number {
    return this.wild.size;
  }

  nearest(pos: Vector3, maxDist: number, filter?: (w: WildEntity) => boolean): WildEntity | null {
    let best: WildEntity | null = null;
    let bestD = maxDist;
    for (const w of this.wild.values()) {
      if (w.held || (filter && !filter(w))) continue;
      const d = Vector3.Distance(pos, w.view.root.position);
      if (d < bestD) {
        bestD = d;
        best = w;
      }
    }
    return best;
  }

  update(dt: number, camera: Vector3, viewDistance: number): void {
    const zone = this.zone();
    const level = this.terrain.waterLevel(zone);
    for (const w of this.wild.values()) {
      const root = w.view.root;
      const far = Vector3.Distance(camera, w.target) > viewDistance;
      const visible = !w.held && !far;
      if (root.isEnabled() !== visible) w.view.setVisible(visible);
      if (!visible) {
        root.position.copyFrom(w.target);
        continue;
      }
      if (!w.pinned) {
        if (Vector3.Distance(root.position, w.target) > 12) root.position.copyFrom(w.target);
        else root.position.copyFrom(Vector3.Lerp(root.position, w.target, Math.min(1, dt * 9)));
        root.rotation.y = lerpAngle(root.rotation.y, w.rotTarget, Math.min(1, dt * 8));
      }
      const ground = Math.max(this.terrain.height(zone, root.position.x, root.position.z), level ?? -Infinity);
      w.view.update(dt, ground);
    }
  }
}
