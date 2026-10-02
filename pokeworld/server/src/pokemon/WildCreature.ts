import type { MovementMode, SpeciesDef } from "@shared/types/content";
import type { CreatureAnim, CreatureInstance, WildSnapshot } from "@shared/types/game";

export type WildState = "idle" | "wander" | "flee" | "approach" | "battle" | "watch";

export class WildCreature {
  state: WildState = "idle";
  anim: CreatureAnim = "idle";
  target: { x: number; z: number } | null = null;
  stateUntil = 0;
  /** Set whenever position/anim changes; cleared after replication. */
  dirty = true;
  lastPlayerNear: number;
  /** Cruising height above ground for fliers. */
  readonly flyHeight: number;
  /** Server tick of the next AI update (distance-throttled). */
  nextTick = 0;

  constructor(
    readonly id: string,
    readonly creature: CreatureInstance,
    readonly species: SpeciesDef,
    public zone: string,
    public x: number,
    public y: number,
    public z: number,
    public rotY: number,
    readonly mode: MovementMode,
    readonly home: { x: number; z: number },
    now: number,
    readonly ruleId?: string,
    readonly special?: "guardian" | "legendary",
    /** Story creatures are only replicated to the player they belong to. */
    readonly owner?: string,
  ) {
    this.lastPlayerNear = now;
    this.flyHeight = 6 + ((id.charCodeAt(id.length - 1) % 6) as number);
  }

  snapshot(): WildSnapshot {
    return {
      id: this.id,
      species: this.creature.species,
      level: this.creature.level,
      zone: this.zone,
      x: this.x,
      y: this.y,
      z: this.z,
      rotY: this.rotY,
      anim: this.anim,
      special: this.special,
    };
  }
}
