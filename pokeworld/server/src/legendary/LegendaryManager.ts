import type { ContentDB } from "@shared/data/contentDb";
import type { LegendaryEventDef, LegendaryNode } from "@shared/types/content";
import type { WorldClock } from "@shared/types/game";
import type { Player } from "../player/Player";

export interface LegendaryBattleRequest {
  kind: "guardian" | "legendary";
  eventId: string;
  nodeId: string;
  species: string;
  level: number;
  target: string;
}

export interface LegendaryResult {
  /** Story lines to show the player. */
  lines: string[];
  /** Node texts newly completed (shown as clue toasts). */
  progressed: string[];
  battle?: LegendaryBattleRequest;
  /** True when this result consumed the interaction (no default dialog needed). */
  handled: boolean;
}

const empty = (): LegendaryResult => ({ lines: [], progressed: [], handled: false });

/**
 * Legendary encounters are JSON event graphs (content/legendary), not random
 * spawns. A node becomes active once all nodes pointing at it are complete.
 * Progress is per player and a completed event can never pay out again.
 */
export class LegendaryManager {
  constructor(private readonly db: ContentDB) {}

  private done(p: Player, ev: LegendaryEventDef): string[] {
    return (p.save.legendary.nodes[ev.id] ??= []);
  }

  activeNodes(p: Player, ev: LegendaryEventDef): LegendaryNode[] {
    if (p.save.legendary.completed.includes(ev.id)) return [];
    const done = new Set(this.done(p, ev));
    return ev.nodes.filter((n) => {
      if (done.has(n.id)) return false;
      const parents = ev.nodes.filter((m) => m.next.includes(n.id));
      if (parents.length === 0) return n.id === ev.start;
      return parents.every((m) => done.has(m.id));
    });
  }

  complete(p: Player, ev: LegendaryEventDef, node: LegendaryNode, result: LegendaryResult): void {
    const done = this.done(p, ev);
    if (done.includes(node.id)) return;
    done.push(node.id);
    result.progressed.push(node.text);
    p.dirty = true;
    if (node.next.length === 0 && !p.save.legendary.completed.includes(ev.id)) p.save.legendary.completed.push(ev.id);
  }

  onTalk(p: Player, npc: string): LegendaryResult {
    const r = empty();
    for (const ev of this.db.legendary.values())
      for (const n of this.activeNodes(p, ev)) if (n.kind === "rumor" && n.npc === npc) this.complete(p, ev, n, r);
    this.settle(p, r);
    return r;
  }

  onVisit(p: Player, area: string): LegendaryResult {
    const r = empty();
    for (const ev of this.db.legendary.values())
      for (const n of this.activeNodes(p, ev)) if (n.kind === "visit" && n.area === area) this.complete(p, ev, n, r);
    this.settle(p, r);
    return r;
  }

  onInventory(p: Player): LegendaryResult {
    const r = empty();
    this.settle(p, r);
    return r;
  }

  onInteract(p: Player, target: string, clock: WorldClock): LegendaryResult {
    const r = empty();
    for (const ev of this.db.legendary.values()) {
      for (const n of this.activeNodes(p, ev)) {
        if (n.kind === "interact" && n.target === target) {
          this.complete(p, ev, n, r);
        } else if (n.kind === "condition" && n.target === target) {
          r.handled = true;
          if (n.time && !n.time.includes(clock.period)) {
            r.lines.push("제단의 홈이 희미하게 빛난다… 아직 때가 아닌 것 같다. (밤에 다시 와 보자)");
            continue;
          }
          if (n.weather && !n.weather.includes(clock.weather)) {
            r.lines.push("하늘의 기운이 맞지 않는 것 같다…");
            continue;
          }
          if (n.consumeItem && p.count(n.consumeItem.id) < n.consumeItem.count) {
            const name = this.db.items.get(n.consumeItem.id)?.name ?? n.consumeItem.id;
            r.lines.push(`제단의 홈에 꼭 맞는 무언가가 필요하다… (${name})`);
            continue;
          }
          if (n.consumeItem) p.consume(n.consumeItem.id, n.consumeItem.count);
          r.lines.push("수정 조각을 제단에 바쳤다. 땅이 울리기 시작한다…!");
          this.complete(p, ev, n, r);
        } else if ((n.kind === "guardian" || n.kind === "encounter") && n.target === target) {
          r.handled = true;
          r.battle = {
            kind: n.kind === "guardian" ? "guardian" : "legendary",
            eventId: ev.id,
            nodeId: n.id,
            species: n.species,
            level: n.level,
            target,
          };
          r.lines.push(n.kind === "guardian" ? "고대수호자가 깨어났다!" : "새벽빛과 함께 전설의 크리처가 내려왔다!");
        }
      }
    }
    // A condition just completed may immediately unlock the guardian at the same target
    if (!r.battle && r.progressed.length > 0) {
      for (const ev of this.db.legendary.values())
        for (const n of this.activeNodes(p, ev))
          if (n.kind === "guardian" && n.target === target) {
            r.battle = { kind: "guardian", eventId: ev.id, nodeId: n.id, species: n.species, level: n.level, target };
            r.lines.push("고대수호자가 깨어났다!");
          }
    }
    this.settle(p, r);
    return r;
  }

  /** Called when a guardian is defeated or the legendary is caught. */
  onBattleResolved(p: Player, req: LegendaryBattleRequest, success: boolean): LegendaryResult {
    const r = empty();
    const ev = this.db.legendary.get(req.eventId);
    const node = ev?.nodes.find((n) => n.id === req.nodeId);
    if (!ev || !node || !success) return r;
    if (!this.activeNodes(p, ev).some((n) => n.id === node.id)) return r;
    this.complete(p, ev, node, r);
    return r;
  }

  /** Completes collect nodes the inventory already satisfies (repeat until stable). */
  private settle(p: Player, r: LegendaryResult): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const ev of this.db.legendary.values())
        for (const n of this.activeNodes(p, ev))
          if (n.kind === "collect" && p.count(n.item) >= n.count) {
            this.complete(p, ev, n, r);
            changed = true;
          }
    }
  }

  /** Current clue text for each in-progress event, for the HUD. */
  clues(p: Player): { event: string; text: string }[] {
    const out: { event: string; text: string }[] = [];
    for (const ev of this.db.legendary.values()) {
      if (p.save.legendary.completed.includes(ev.id)) continue;
      if (this.done(p, ev).length === 0) continue;
      for (const n of this.activeNodes(p, ev)) out.push({ event: ev.name, text: n.text });
    }
    return out;
  }
}
