import type { ContentDB } from "@shared/data/contentDb";
import type { LegendaryEventDef } from "@shared/types/content";
import type { PlayerPrivateState } from "@shared/types/game";
import { escapeHtml } from "../ui/dom";

/** Nodes the player can work on next (all parents done), mirroring the server's graph rules. */
export function activeLegendaryNodes(ev: LegendaryEventDef, done: string[]) {
  const set = new Set(done);
  return ev.nodes.filter((n) => {
    if (set.has(n.id)) return false;
    const parents = ev.nodes.filter((m) => m.next.includes(n.id));
    return parents.length === 0 ? n.id === ev.start : parents.every((m) => set.has(m.id));
  });
}

/** Quest tracker text for the HUD: up to two active quests plus the current legendary clue. */
export function questHud(db: ContentDB, st: PlayerPrivateState): string {
  const parts: string[] = [];
  const active = Object.keys(st.quests.active)
    .map((id) => db.quests.get(id))
    .filter((q): q is NonNullable<typeof q> => !!q)
    .sort((a, b) => (a.type === "main" ? -1 : 0) - (b.type === "main" ? -1 : 0))
    .slice(0, 2);

  for (const q of active) {
    const prog = st.quests.active[q.id] ?? {};
    const lines = q.objectives.map((o) => {
      const need = "count" in o ? o.count : 1;
      const have = Math.min(need, prog[o.id] ?? 0);
      const done = have >= need;
      return `<div>${done ? "✔" : "○"} ${escapeHtml(o.text)}${need > 1 ? ` (${have}/${need})` : ""}</div>`;
    });
    parts.push(`<b>${escapeHtml(q.title)}</b>${lines.join("")}`);
  }

  for (const ev of db.legendary.values()) {
    if (st.legendary.completed.includes(ev.id)) continue;
    const done = st.legendary.nodes[ev.id] ?? [];
    if (done.length === 0) continue;
    for (const n of activeLegendaryNodes(ev, done)) parts.push(`<div class="legend">✦ ${escapeHtml(ev.name)}: ${escapeHtml(n.text)}</div>`);
  }
  return parts.join("");
}
