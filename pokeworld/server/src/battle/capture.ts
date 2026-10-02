import type { ContentDB } from "@shared/data/contentDb";
import { maxHp } from "@shared/data/stats";
import type { Rng } from "@shared/math/rng";
import type { CreatureInstance } from "@shared/types/game";

export interface CaptureRoll {
  shakes: number;
  success: boolean;
  /** Probability of success for these inputs (for tests/UI hints). */
  chance: number;
}

/**
 * Lower HP and better orbs raise the odds. `bonus` multiplies everything
 * (orb strength x situational bonuses). Three shake checks, as in the classic
 * formula: a = (3M - 2H) * rate * bonus / 3M, shake p = (a / 255)^(1/4).
 */
export function rollCapture(db: ContentDB, target: CreatureInstance, bonus: number, rng: Rng): CaptureRoll {
  const m = maxHp(db, target);
  const h = Math.max(1, target.hp);
  const rate = db.speciesOf(target).catchRate;
  const a = Math.min(255, ((3 * m - 2 * h) * rate * bonus) / (3 * m));
  const shakeP = Math.pow(a / 255, 0.25);
  const chance = Math.pow(shakeP, 3);

  if (a >= 255) return { shakes: 3, success: true, chance: 1 };

  for (let i = 0; i < 3; i++) if (rng.next() >= shakeP) return { shakes: i, success: false, chance };
  return { shakes: 3, success: true, chance };
}
