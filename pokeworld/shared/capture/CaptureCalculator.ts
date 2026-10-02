import type { BallDef, CaptureConfigDef, StatusCondition } from "../types/content";

/** Everything that influences one capture attempt. */
export interface CaptureContext {
  speciesCatchRate: number;
  currentHP: number;
  maxHP: number;
  level: number;
  status: StatusCondition | "none";
  /** Ball item id (poke_ball, great_ball, ...). */
  ball: string;
  /** 1 for the first turn of a battle and for throws in the field. */
  battleTurn: number;
  inBattle: boolean;
  biome: string;
  /** 0..15 */
  lightLevel: number;
  isCave: boolean;
  isNight: boolean;
  /** Target is swimming on or under water. */
  isInWater: boolean;
  isUnderwater: boolean;
  targetTypes: string[];
  previouslyCaught: boolean;
  alpha: boolean;
  legendary: boolean;
  rarity?: "common" | "uncommon" | "rare" | "very_rare";
  /** Highest level in the thrower's party (strong targets resist). */
  playerLevel: number;
  /** Field throw at a Pokémon that has not noticed the player. */
  unaware: boolean;
  /** Distinct species caught (critical-capture chance grows with it). */
  caughtCount: number;
}

export interface CaptureRoll {
  /** Visible shakes before the result (0..3; a critical capture shows 1). */
  shakes: number;
  success: boolean;
  critical: boolean;
  /** Probability of success for these inputs. */
  chance: number;
  /** Modified catch rate "a" (1..255). */
  modifiedRate: number;
  ballMultiplier: number;
}

export interface Random {
  next(): number;
}

/**
 * Capture formula in the style of the main-series games (and Cobblemon's
 * situational balls), driven entirely by content/capture/*.json:
 *
 *   a = (3M - 2H) * rate * ball * status * lowLevel / 3M
 *       * alpha * legendary * rarity * overLevel * field bonuses
 *   p(shake) = (a / 255) ^ shakeExponent    (4 checks: 3 shakes + the click)
 *   p(critical) = a * caughtStep * scale / 256  (one check only)
 */
export class CaptureCalculator {
  constructor(
    readonly config: CaptureConfigDef,
    private readonly balls: Map<string, BallDef>,
  ) {}

  /** Ball multiplier for the situation: the best matching condition, else the base multiplier. */
  ballMultiplier(ctx: CaptureContext): number {
    const def = this.balls.get(ctx.ball);
    let m = def?.baseMultiplier ?? 1;
    for (const c of def?.conditions ?? []) {
      let v = 0;
      switch (c.when) {
        case "firstTurn":
          if (ctx.battleTurn <= c.maxTurn) v = c.multiplier;
          break;
        case "water":
          if (ctx.isInWater || ctx.isUnderwater) v = c.multiplier;
          break;
        case "dark":
          if (ctx.lightLevel <= c.maxLight) v = c.multiplier;
          break;
        case "cave":
          if (ctx.isCave) v = c.multiplier;
          break;
        case "night":
          if (ctx.isNight) v = c.multiplier;
          break;
        case "targetType":
          if (ctx.targetTypes.some((t) => c.types.includes(t))) v = c.multiplier;
          break;
        case "turnScaling":
          v = Math.min(c.max, 1 + c.perTurn * Math.max(0, ctx.battleTurn));
          break;
        case "previouslyCaught":
          if (ctx.previouslyCaught) v = c.multiplier;
          break;
        case "lowLevel":
          if (ctx.level <= c.maxLevel) v = c.multiplier;
          break;
      }
      if (v > m) m = v;
    }
    return m;
  }

  statusMultiplier(status: CaptureContext["status"]): number {
    return this.config.status[status] ?? 1;
  }

  lowLevelMultiplier(level: number): number {
    const l = this.config.lowLevel;
    if (level >= l.belowLevel) return 1;
    return Math.max(1, (l.base - l.perLevel * level) / l.divisor);
  }

  overLevelMultiplier(level: number, playerLevel: number): number {
    const diff = level - playerLevel;
    if (diff <= 0) return 1;
    return Math.max(this.config.overLevel.min, 1 - diff * this.config.overLevel.perLevel);
  }

  /** Modified catch rate "a", clamped to 1..maxModifiedRate. */
  modifiedRate(ctx: CaptureContext): { a: number; ball: number } {
    const cfg = this.config;
    const M = Math.max(1, ctx.maxHP);
    const H = Math.max(1, Math.min(ctx.currentHP, M));
    const ball = this.ballMultiplier(ctx);
    let a = ((3 * M - 2 * H) * ctx.speciesCatchRate * ball * this.statusMultiplier(ctx.status) * this.lowLevelMultiplier(ctx.level)) / (3 * M);
    if (ctx.alpha) a *= cfg.alphaMultiplier;
    if (ctx.legendary) a *= cfg.legendaryMultiplier;
    if (ctx.rarity === "rare" || ctx.rarity === "very_rare") a *= cfg.rareMultiplier[ctx.rarity] ?? 1;
    a *= this.overLevelMultiplier(ctx.level, ctx.playerLevel);
    if (!ctx.inBattle && ctx.unaware) a *= cfg.fieldThrow.unawareBonus;
    if (ctx.inBattle) a *= cfg.fieldThrow.battleBonus;
    if (ctx.isUnderwater) a *= cfg.environment.underwaterPenalty;
    return { a: Math.max(1, Math.min(cfg.maxModifiedRate, a)), ball };
  }

  shakeProbability(a: number): number {
    if (a >= this.config.maxModifiedRate) return 1;
    return Math.pow(a / 255, this.config.shakeExponent);
  }

  criticalChance(a: number, caughtCount: number): number {
    const c = this.config.critical;
    if (!c.enabled) return 0;
    let step = 0;
    for (const [count, mult] of c.caughtSteps) if (caughtCount >= count) step = mult;
    return Math.min(1, (a * step * c.scale) / 256);
  }

  /** Probability of success (normal capture path). */
  chance(ctx: CaptureContext): number {
    const { a } = this.modifiedRate(ctx);
    return Math.pow(this.shakeProbability(a), this.config.shakeChecks);
  }

  roll(ctx: CaptureContext, rng: Random): CaptureRoll {
    const { a, ball } = this.modifiedRate(ctx);
    const p = this.shakeProbability(a);
    const chance = Math.pow(p, this.config.shakeChecks);
    const base = { modifiedRate: a, ballMultiplier: ball, chance };
    if (rng.next() < this.criticalChance(a, ctx.caughtCount)) {
      // Critical capture: one strong shake, one check
      return { ...base, critical: true, shakes: 1, success: rng.next() < p };
    }
    const checks = this.config.shakeChecks;
    let passed = 0;
    while (passed < checks && rng.next() < p) passed++;
    return { ...base, critical: false, shakes: Math.min(this.config.maxShakes, passed), success: passed === checks };
  }
}
