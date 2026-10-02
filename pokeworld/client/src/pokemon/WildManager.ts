import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { lerpAngle } from "@shared/math/vec";
import type { CreatureMove } from "@shared/protocol/messages";
import type { WildSnapshot } from "@shared/types/game";
import type { PokemonLibrary } from "./PokemonLibrary";
import type { PokemonView } from "./PokemonView";

export interface WildEntity {
  snap: WildSnapshot;
  view: PokemonView;
  target: Vector3;
  rotTarget: number;
  /** Hidden while inside a Poké Ball (capture sequence). */
  held: boolean;
  /** Owned by battle staging or a capture sequence (no interpolation). */
  pinned: boolean;
}

/**
 * Replicated wild Pokémon: smoothing between 10 Hz server updates, distance
 * culling (view distance from the quality preset), and pooled views.
 */
export class WildManager {
  private readonly wild = new Map<string, WildEntity>();

  constructor(private readonly lib: PokemonLibrary) {}

  spawn(list: WildSnapshot[]): void {
    for (const s of list) {
      if (this.wild.has(s.id)) continue;
      const view = this.lib.acquire(s.species, { size: s.size, alpha: s.alpha });
      view.root.position.set(s.x, s.y, s.z);
      view.root.rotation.y = s.rotY;
      view.anim = s.anim;
      view.mode = s.mode;
      this.wild.set(s.id, { snap: s, view, target: new Vector3(s.x, s.y, s.z), rotTarget: s.rotY, held: false, pinned: false });
    }
  }

  move(list: CreatureMove[]): void {
    for (const m of list) {
      const w = this.wild.get(m.id);
      if (!w) continue;
      w.target.set(m.x, m.y, m.z);
      w.rotTarget = m.rotY;
      if (!w.pinned || m.anim === "battle") {
        w.view.anim = m.anim;
        if (m.anim === "recoil") w.view.playRecoil();
        if (m.anim === "swim") w.view.mode = w.snap.mode === "dive" ? "dive" : "swim";
        else if (m.anim === "fly") w.view.mode = "fly";
        else if (m.anim === "walk" || m.anim === "run") w.view.mode = "walk";
      }
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
        setTimeout(() => this.lib.release(w.view), 1300);
      } else this.lib.release(w.view);
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
    for (const w of this.wild.values()) {
      const root = w.view.root;
      const far = Vector3.Distance(camera, w.target) > viewDistance;
      const visible = !w.held && !far;
      if (root.isEnabled() !== visible) w.view.setVisible(visible);
      if (!visible) {
        if (!w.pinned) root.position.copyFrom(w.target);
        continue;
      }
      if (!w.pinned) {
        if (Vector3.Distance(root.position, w.target) > 12) root.position.copyFrom(w.target);
        else root.position.copyFrom(Vector3.Lerp(root.position, w.target, Math.min(1, dt * 9)));
        root.rotation.y = lerpAngle(root.rotation.y, w.rotTarget, Math.min(1, dt * 8));
      }
      w.view.update(dt);
    }
  }
}
