import type { ContentDB } from "@shared/data/contentDb";
import type { ServerMessage } from "@shared/protocol/messages";
import type { AnimState, PlayerPrivateState, PlayerSnapshot } from "@shared/types/game";
import type { PlayerSave } from "@shared/types/save";
import type { Battle } from "../battle/Battle";

export interface Connection {
  send(msg: ServerMessage): void;
}

/** A connected player: persistent save plus runtime-only session state. */
export class Player {
  anim: AnimState = "idle";
  /** Species ridden, if mounted. */
  mounted: string | null = null;
  battle: Battle | null = null;
  readonly knownCreatures = new Set<string>();
  readonly knownPlayers = new Set<string>();
  lastMoveAt = 0;
  lastSeq = -1;
  moved = true;
  dirty = false;
  lastSavedAt = 0;
  lastAreaCheck = 0;
  nextSpawnCheck = 0;
  /** Simple flood control: messages handled in the current second. */
  msgWindowStart = 0;
  msgCount = 0;
  sessionStart: number;

  constructor(
    public save: PlayerSave,
    public conn: Connection,
    now: number,
  ) {
    this.sessionStart = now;
    this.lastMoveAt = now;
  }

  get id(): string {
    return this.save.id;
  }
  get zone(): string {
    return this.save.zone;
  }
  get x(): number {
    return this.save.x;
  }
  get z(): number {
    return this.save.z;
  }

  count(item: string): number {
    return this.save.inventory[item] ?? 0;
  }

  add(item: string, n = 1): void {
    this.save.inventory[item] = this.count(item) + n;
    this.dirty = true;
  }

  consume(item: string, n = 1): boolean {
    if (this.count(item) < n) return false;
    this.save.inventory[item] = this.count(item) - n;
    if (this.save.inventory[item] <= 0) delete this.save.inventory[item];
    this.dirty = true;
    return true;
  }

  privateState(): PlayerPrivateState {
    const s = this.save;
    return {
      party: s.party,
      boxCount: s.box.length,
      inventory: s.inventory,
      money: s.money,
      flags: s.flags,
      quests: s.quests,
      legendary: s.legendary,
      seen: s.seen,
      caught: s.caught,
      mounted: this.mounted !== null,
    };
  }

  snapshot(_db: ContentDB): PlayerSnapshot {
    const s = this.save;
    const lead = s.party.find((c) => c.hp > 0);
    return {
      id: s.id,
      name: s.name,
      zone: s.zone,
      x: s.x,
      y: s.y,
      z: s.z,
      rotY: s.rotY,
      anim: this.anim,
      mount: this.mounted ?? undefined,
      follower: this.mounted ? undefined : lead?.species,
      inBattle: this.battle !== null,
    };
  }

  send(msg: ServerMessage): void {
    this.conn.send(msg);
  }
}
