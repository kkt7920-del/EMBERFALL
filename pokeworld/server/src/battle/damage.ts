import type { ContentDB } from "@shared/data/contentDb";
import { computeStats } from "@shared/data/stats";
import type { Rng } from "@shared/math/rng";
import type { MoveDef, StatKey } from "@shared/types/content";
import type { CreatureInstance } from "@shared/types/game";

export type StageKey = Exclude<StatKey, "hp">;
export type Stages = Record<StageKey, number>;

export const freshStages = (): Stages => ({ atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });

export function stageMultiplier(stage: number): number {
  return stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
}

export function effectiveStat(db: ContentDB, c: CreatureInstance, stat: StageKey, stages: Stages): number {
  return computeStats(db.speciesOf(c), c.level, c.ivs)[stat] * stageMultiplier(stages[stat]);
}

export interface DamageResult {
  damage: number;
  eff: number;
  crit: boolean;
}

/** Classic level/power/attack/defence formula with STAB, type chart, crits and a 85–100% roll. */
export function computeDamage(
  db: ContentDB,
  attacker: CreatureInstance,
  attackerStages: Stages,
  defender: CreatureInstance,
  defenderStages: Stages,
  move: MoveDef,
  rng: Rng,
): DamageResult {
  if (move.category === "status" || move.power <= 0) return { damage: 0, eff: 1, crit: false };

  const physical = move.category === "physical";
  const crit = rng.next() < 1 / 16;
  // Critical hits ignore the attacker's negative and the defender's positive stages
  const aStages = crit ? { ...attackerStages, atk: Math.max(0, attackerStages.atk), spa: Math.max(0, attackerStages.spa) } : attackerStages;
  const dStages = crit ? { ...defenderStages, def: Math.min(0, defenderStages.def), spd: Math.min(0, defenderStages.spd) } : defenderStages;

  const a = effectiveStat(db, attacker, physical ? "atk" : "spa", aStages);
  const d = Math.max(1, effectiveStat(db, defender, physical ? "def" : "spd", dStages));

  const base = Math.floor(Math.floor((Math.floor((2 * attacker.level) / 5 + 2) * move.power * a) / d) / 50) + 2;
  const stab = db.speciesOf(attacker).types.includes(move.type) ? 1.5 : 1;
  const eff = db.effectiveness(move.type, db.speciesOf(defender).types);
  if (eff === 0) return { damage: 0, eff, crit: false };

  const roll = 0.85 + rng.next() * 0.15;
  const damage = Math.max(1, Math.floor(base * stab * eff * (crit ? 1.5 : 1) * roll));
  return { damage, eff, crit };
}
