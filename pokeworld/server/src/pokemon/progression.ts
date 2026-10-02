import type { ContentDB } from "@shared/data/contentDb";
import { MAX_LEVEL, computeStats, creatureName, expForLevel } from "@shared/data/stats";
import type { BattleEvent } from "@shared/types/battle";
import type { CreatureInstance } from "@shared/types/game";

/** Experience for defeating `foe`. Trainer/boss battles pay 1.5x. */
export function expReward(db: ContentDB, foe: CreatureInstance, boosted: boolean): number {
  const base = db.speciesOf(foe).baseExp;
  return Math.max(1, Math.floor(((base * foe.level) / 7) * (boosted ? 1.5 : 1)));
}

/** Adds exp, levels up, learns moves. HP grows with max HP so damage taken is kept. */
export function grantExp(db: ContentDB, c: CreatureInstance, amount: number): BattleEvent[] {
  const events: BattleEvent[] = [];
  if (c.level >= MAX_LEVEL) return events;
  const name = creatureName(db, c);
  c.exp += amount;
  events.push({ t: "exp", uid: c.uid, name, amount });

  while (c.level < MAX_LEVEL && c.exp >= expForLevel(c.level + 1)) {
    const species = db.speciesOf(c);
    const before = computeStats(species, c.level, c.ivs).hp;
    c.level++;
    const after = computeStats(species, c.level, c.ivs).hp;
    if (c.hp > 0) c.hp = Math.min(after, c.hp + (after - before));
    events.push({ t: "level", uid: c.uid, name, level: c.level });

    for (const l of species.learnset) {
      if (l.level !== c.level || c.moves.some((m) => m.id === l.move)) continue;
      const move = db.moves.get(l.move)!;
      if (c.moves.length < 4) {
        c.moves.push({ id: move.id, pp: move.pp });
        events.push({ t: "learn", uid: c.uid, name, move: move.name });
      } else {
        // Replace the weakest move, but only if the new one is stronger
        let weakest = 0;
        for (let i = 1; i < c.moves.length; i++)
          if ((db.moves.get(c.moves[i].id)?.power ?? 0) < (db.moves.get(c.moves[weakest].id)?.power ?? 0)) weakest = i;
        const old = db.moves.get(c.moves[weakest].id)!;
        if (move.power > old.power) {
          c.moves[weakest] = { id: move.id, pp: move.pp };
          events.push({ t: "learn", uid: c.uid, name, move: move.name, replaced: old.name });
        }
      }
    }
  }
  return events;
}

/** Evolves when the level threshold is met. Keeps damage taken, adds newly learnable moves. */
export function evolveIfReady(db: ContentDB, c: CreatureInstance): BattleEvent | null {
  const species = db.speciesOf(c);
  if (!species.evolution || c.level < species.evolution.level) return null;
  const target = db.species.get(species.evolution.to);
  if (!target) return null;

  const before = computeStats(species, c.level, c.ivs).hp;
  const after = computeStats(target, c.level, c.ivs).hp;
  c.species = target.id;
  if (c.hp > 0) c.hp = Math.min(after, c.hp + (after - before));

  for (const l of target.learnset) {
    if (l.level > c.level || c.moves.some((m) => m.id === l.move) || c.moves.length >= 4) continue;
    c.moves.push({ id: l.move, pp: db.moves.get(l.move)!.pp });
  }
  return { t: "evolve", uid: c.uid, from: species.name, to: target.name };
}
