import type { ContentDB } from "@shared/data/contentDb";
import type { QuestDef } from "@shared/types/content";
import type { Player } from "../player/Player";

export type QuestEvent =
  | { kind: "obtain_partner" }
  | { kind: "catch"; species: string }
  | { kind: "defeat_trainer"; trainer: string }
  | { kind: "win_battle" }
  | { kind: "visit"; area: string }
  | { kind: "talk"; npc: string }
  | { kind: "inventory" };

export interface QuestChanges {
  started: string[];
  completed: string[];
  /** Human-readable reward lines for completed quests. */
  rewards: string[];
}

/** Data-driven quests. All progress and rewards are decided here, server-side. */
export class QuestManager {
  constructor(private readonly db: ContentDB) {}

  /** Starts every quest whose prerequisites are done, then settles inventory-based objectives. */
  refresh(p: Player): QuestChanges {
    const changes: QuestChanges = { started: [], completed: [], rewards: [] };
    let again = true;
    while (again) {
      again = false;
      for (const q of this.db.quests.values()) {
        const st = p.save.quests;
        if (st.completed.includes(q.id) || st.active[q.id]) continue;
        if (!q.requires.every((r) => st.completed.includes(r))) continue;
        st.active[q.id] = {};
        changes.started.push(q.id);
        p.dirty = true;
        // Retroactive objectives (already have a partner, already own items)
        if (q.objectives.some((o) => o.kind === "obtain_partner") && p.save.party.length > 0) this.bump(p, q, "obtain_partner", 1);
        if (this.tryComplete(p, q, changes)) again = true;
      }
    }
    this.apply(p, { kind: "inventory" }, changes);
    return changes;
  }

  handle(p: Player, ev: QuestEvent): QuestChanges {
    const changes: QuestChanges = { started: [], completed: [], rewards: [] };
    this.apply(p, ev, changes);
    if (changes.completed.length > 0) {
      const more = this.refresh(p);
      changes.started.push(...more.started);
      changes.completed.push(...more.completed);
      changes.rewards.push(...more.rewards);
    }
    return changes;
  }

  private apply(p: Player, ev: QuestEvent, changes: QuestChanges): void {
    for (const id of Object.keys(p.save.quests.active)) {
      const q = this.db.quests.get(id);
      if (!q) continue;
      for (const o of q.objectives) {
        switch (o.kind) {
          case "obtain_partner":
            if (ev.kind === "obtain_partner") this.bump(p, q, o.id, 1);
            break;
          case "catch":
            if (ev.kind === "catch" && (!o.species || o.species === ev.species)) this.bump(p, q, o.id, 1);
            break;
          case "defeat_trainer":
            if (ev.kind === "defeat_trainer" && ev.trainer === o.trainer) this.bump(p, q, o.id, 1);
            break;
          case "win_battles":
            if (ev.kind === "win_battle") this.bump(p, q, o.id, 1);
            break;
          case "visit":
            if (ev.kind === "visit" && ev.area === o.area) this.bump(p, q, o.id, 1);
            break;
          case "talk":
            if (ev.kind === "talk" && ev.npc === o.npc) this.bump(p, q, o.id, 1);
            break;
          case "collect":
            p.save.quests.active[q.id][o.id] = Math.min(o.count, p.count(o.item));
            break;
        }
      }
      this.tryComplete(p, q, changes);
    }
  }

  private bump(p: Player, q: QuestDef, objective: string, n: number): void {
    const prog = p.save.quests.active[q.id];
    if (!prog) return;
    prog[objective] = (prog[objective] ?? 0) + n;
    p.dirty = true;
  }

  private tryComplete(p: Player, q: QuestDef, changes: QuestChanges): boolean {
    const prog = p.save.quests.active[q.id];
    if (!prog) return false;
    const done = q.objectives.every((o) => (prog[o.id] ?? 0) >= ("count" in o ? o.count : 1));
    if (!done) return false;

    delete p.save.quests.active[q.id];
    p.save.quests.completed.push(q.id);
    if (q.rewards.money) {
      p.save.money += q.rewards.money;
      changes.rewards.push(`${q.rewards.money}원`);
    }
    for (const it of q.rewards.items ?? []) {
      p.add(it.id, it.count);
      changes.rewards.push(`${this.db.items.get(it.id)?.name ?? it.id} ×${it.count}`);
    }
    changes.completed.push(q.id);
    p.dirty = true;
    return true;
  }

  objectiveDone(p: Player, questId: string, objectiveId: string): boolean {
    const q = this.db.quests.get(questId);
    const o = q?.objectives.find((x) => x.id === objectiveId);
    if (!q || !o) return false;
    if (p.save.quests.completed.includes(questId)) return true;
    return (p.save.quests.active[questId]?.[objectiveId] ?? 0) >= ("count" in o ? o.count : 1);
  }
}
