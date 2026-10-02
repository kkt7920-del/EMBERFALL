import type { ContentDB } from "@shared/data/contentDb";
import { maxHp } from "@shared/data/stats";
import type { SpeciesDef } from "@shared/types/content";
import type { CreatureAnim, CreatureInstance, WildMode, WildSnapshot } from "@shared/types/game";

export type WildState = "idle" | "wander" | "flee" | "approach" | "battle" | "watch" | "capturing";

/** A wild Pokémon in the world (server-side). */
export class WildCreature {
  state: WildState = "idle";
  anim: CreatureAnim = "idle";
  target: { x: number; y: number; z: number } | null = null;
  stateUntil = 0;
  /** Set whenever position/anim changes; cleared after replication. */
  dirty = true;
  lastPlayerNear: number;
  /** Cruising height above ground for fliers. */
  readonly flyHeight: number;
  /** Server tick of the next AI update (distance-throttled). */
  nextTick = 0;
  /** Has noticed a player recently (affects field-capture odds). */
  alertUntil = 0;

  constructor(
    readonly id: string,
    readonly creature: CreatureInstance,
    readonly species: SpeciesDef,
    public zone: string,
    public x: number,
    public y: number,
    public z: number,
    public rotY: number,
    public mode: WildMode,
    readonly home: { x: number; y: number; z: number },
    now: number,
    readonly ruleId?: string,
    readonly special?: "guardian" | "legendary",
    /** Story Pokémon are only replicated to the player they belong to. */
    readonly owner?: string,
    readonly rarity?: "common" | "uncommon" | "rare" | "very_rare",
  ) {
    this.lastPlayerNear = now;
    this.flyHeight = 4 + (id.charCodeAt(id.length - 1) % 6);
  }

  /** Collision/capture box size at this individual's scale. */
  get width(): number {
    return this.species.hitbox.width * this.creature.size;
  }

  get height(): number {
    return this.species.hitbox.height * this.creature.size;
  }

  /** Budget units this Pokémon uses (large ones count more). */
  get budget(): number {
    const v = this.width * this.width * this.height;
    return Math.max(1, Math.min(4, Math.ceil(v / 2.5)));
  }

  snapshot(db: ContentDB): WildSnapshot {
    const c = this.creature;
    return {
      id: this.id,
      species: c.species,
      level: c.level,
      zone: this.zone,
      x: this.x,
      y: this.y,
      z: this.z,
      rotY: this.rotY,
      anim: this.anim,
      mode: this.mode,
      size: c.size,
      alpha: !!c.alpha,
      gender: c.gender,
      hp: c.hp,
      maxHp: maxHp(db, c),
      status: c.status,
      special: this.special,
    };
  }
}
