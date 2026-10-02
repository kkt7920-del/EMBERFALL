import { describe, expect, it } from "vitest";
import { createCreature, expForLevel, maxHp } from "@shared/data/stats";
import { Rng } from "@shared/math/rng";
import { Battle } from "@server/battle/Battle";
import { CaptureCalculator, type CaptureContext } from "@shared/capture/CaptureCalculator";
import { BALL, newBall, segmentHitsBox, solveThrow, stepBall } from "@shared/capture/ballPhysics";
import { computeDamage, freshStages } from "@server/battle/damage";
import { evolveIfReady, grantExp } from "@server/pokemon/progression";
import { db } from "./helpers";

const inv = (items: Record<string, number>) => ({
  count: (i: string) => items[i] ?? 0,
  consume: (i: string) => ((items[i] ?? 0) > 0 ? (items[i]--, true) : false),
});

describe("damage", () => {
  it("applies type effectiveness and STAB", () => {
    const rng = new Rng(1);
    const fire = createCreature(db, "charmander", 10, rng);
    const grass = createCreature(db, "bulbasaur", 10, rng);
    const water = createCreature(db, "squirtle", 10, rng);
    const ember = db.moves.get("ember")!;
    const vsGrass = computeDamage(db, fire, freshStages(), grass, freshStages(), ember, new Rng(5));
    const vsWater = computeDamage(db, fire, freshStages(), water, freshStages(), ember, new Rng(5));
    expect(vsGrass.eff).toBe(2);
    expect(vsWater.eff).toBe(0.5);
    expect(vsGrass.damage).toBeGreaterThan(vsWater.damage);
  });

  it("immunities deal zero", () => {
    const rng = new Rng(2);
    const spark = db.moves.get("spark")!;
    const mouse = createCreature(db, "pikachu", 10, rng);
    const mud = createCreature(db, "diglett", 10, rng);
    expect(computeDamage(db, mouse, freshStages(), mud, freshStages(), spark, rng).damage).toBe(0);
  });
});

describe("battle flow", () => {
  it("a stronger partner wins a wild battle and gains exp", () => {
    const rng = new Rng(3);
    const party = [createCreature(db, "charizard", 30, rng)];
    const foe = createCreature(db, "caterpie", 3, rng);
    const b = new Battle(db, rng, { id: "b", kind: "wild", playerId: "p", party, foes: [foe], canCapture: true, canRun: true });
    const expBefore = party[0].exp;
    let outcome;
    for (let i = 0; i < 10 && !outcome; i++) {
      const r = b.act({ kind: "move", index: 0 }, inv({}));
      if ("error" in r) throw new Error(r.error);
      outcome = r.outcome;
    }
    expect(outcome).toBe("win");
    expect(party[0].exp).toBeGreaterThan(expBefore);
  });

  it("losing every creature ends in a loss; a faint with backups asks for a switch", () => {
    const rng = new Rng(4);
    const party = [createCreature(db, "caterpie", 2, rng), createCreature(db, "caterpie", 2, rng)];
    const foe = createCreature(db, "golurk", 40, rng);
    const b = new Battle(db, rng, { id: "b", kind: "guardian", playerId: "p", party, foes: [foe], canCapture: false, canRun: false });
    let r = b.act({ kind: "move", index: 0 }, inv({}));
    if ("error" in r) throw new Error(r.error);
    expect(b.awaiting).toBe("switch");
    expect(b.act({ kind: "move", index: 0 }, inv({}))).toHaveProperty("error");
    r = b.act({ kind: "switch", index: 1 }, inv({}));
    if ("error" in r) throw new Error(r.error);
    for (let i = 0; i < 20 && !b.ended; i++) {
      r = b.act({ kind: "move", index: 0 }, inv({}));
      if ("error" in r) throw new Error(r.error);
    }
    expect(b.outcome).toBe("lose");
  });

  it("rejects running in guardian battles", () => {
    const rng = new Rng(5);
    const party = [createCreature(db, "charizard", 30, rng)];
    const foe = createCreature(db, "golurk", 5, rng);
    const b = new Battle(db, rng, { id: "b", kind: "guardian", playerId: "p", party, foes: [foe], canCapture: false, canRun: false });
    expect(b.act({ kind: "run" }, inv({}))).toHaveProperty("error");
  });

  it("healing items are consumed from the inventory", () => {
    const rng = new Rng(6);
    const party = [createCreature(db, "bulbasaur", 10, rng)];
    party[0].hp = 5;
    const foe = createCreature(db, "caterpie", 2, rng);
    const b = new Battle(db, rng, { id: "b", kind: "wild", playerId: "p", party, foes: [foe], canCapture: true, canRun: true });
    const items = { potion: 1 };
    const r = b.act({ kind: "item", item: "potion", target: 0 }, inv(items));
    if ("error" in r) throw new Error(r.error);
    expect(items.potion).toBe(0);
    expect(b.act({ kind: "item", item: "potion", target: 0 }, inv(items))).toHaveProperty("error");
  });
});

describe("status conditions", () => {
  it("sleep powder puts the foe to sleep", () => {
    const rng = new Rng(9);
    const party = [createCreature(db, "bulbasaur", 20, rng)];
    party[0].moves = [{ id: "sleep_powder", pp: 15 }];
    const foe = createCreature(db, "caterpie", 3, rng);
    const b = new Battle(db, new Rng(1), { id: "b", kind: "wild", playerId: "p", party, foes: [foe], canCapture: true, canRun: true });
    for (let i = 0; i < 6 && !foe.status; i++) {
      const r = b.act({ kind: "move", index: 0 }, inv({}));
      if ("error" in r) throw new Error(r.error);
    }
    expect(foe.status).toBe("sleep");
  });
});

const calc = new CaptureCalculator(db.capture!, db.balls);
const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  speciesCatchRate: 190,
  currentHP: 20,
  maxHP: 20,
  level: 5,
  status: "none",
  ball: "poke_ball",
  battleTurn: 1,
  inBattle: false,
  biome: "plains",
  lightLevel: 15,
  isCave: false,
  isNight: false,
  isInWater: false,
  isUnderwater: false,
  targetTypes: ["electric"],
  previouslyCaught: false,
  alpha: false,
  legendary: false,
  playerLevel: 10,
  unaware: false,
  caughtCount: 0,
  ...over,
});

describe("CaptureCalculator", () => {
  it("is easier at low HP, with status and with better balls", () => {
    const base = calc.chance(ctx({ speciesCatchRate: 45 }));
    expect(calc.chance(ctx({ speciesCatchRate: 45, currentHP: 1 }))).toBeGreaterThan(base);
    expect(calc.chance(ctx({ speciesCatchRate: 45, status: "sleep" }))).toBeGreaterThan(calc.chance(ctx({ speciesCatchRate: 45, status: "poison" })));
    expect(calc.chance(ctx({ speciesCatchRate: 45, status: "poison" }))).toBeGreaterThan(base);
    expect(calc.chance(ctx({ speciesCatchRate: 45, ball: "great_ball" }))).toBeGreaterThan(base);
    expect(calc.chance(ctx({ speciesCatchRate: 45, ball: "ultra_ball" }))).toBeGreaterThan(calc.chance(ctx({ speciesCatchRate: 45, ball: "great_ball" })));
  });

  it("special balls only help under their condition", () => {
    const water = ctx({ speciesCatchRate: 45, ball: "net_ball", targetTypes: ["water"] });
    expect(calc.ballMultiplier(water)).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "net_ball", targetTypes: ["fire"] })));
    expect(calc.ballMultiplier(ctx({ ball: "quick_ball", battleTurn: 1 }))).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "quick_ball", battleTurn: 5, inBattle: true })));
    expect(calc.ballMultiplier(ctx({ ball: "dusk_ball", isNight: true }))).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "dusk_ball" })));
    expect(calc.ballMultiplier(ctx({ ball: "dive_ball", isUnderwater: true, isInWater: true }))).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "dive_ball" })));
    expect(calc.ballMultiplier(ctx({ ball: "timer_ball", battleTurn: 11, inBattle: true }))).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "timer_ball", battleTurn: 1, inBattle: true })));
    expect(calc.ballMultiplier(ctx({ ball: "repeat_ball", previouslyCaught: true }))).toBeGreaterThan(calc.ballMultiplier(ctx({ ball: "repeat_ball" })));
  });

  it("alpha and legendary Pokémon resist", () => {
    const base = calc.chance(ctx({ speciesCatchRate: 45, currentHP: 5 }));
    expect(calc.chance(ctx({ speciesCatchRate: 45, currentHP: 5, alpha: true }))).toBeLessThan(base);
    expect(calc.chance(ctx({ speciesCatchRate: 3, currentHP: 5, legendary: true }))).toBeLessThan(calc.chance(ctx({ speciesCatchRate: 3, currentHP: 5 })));
  });

  it("rolls 0..3 visible shakes and matches its stated chance", () => {
    const rng = new Rng(11);
    const c = ctx({ speciesCatchRate: 45, currentHP: 8 });
    let ok = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const r = calc.roll(c, rng);
      expect(r.shakes).toBeGreaterThanOrEqual(0);
      expect(r.shakes).toBeLessThanOrEqual(3);
      if (r.critical) expect(r.shakes).toBe(1);
      else if (r.success) expect(r.shakes).toBe(3);
      if (r.success) ok++;
    }
    const chance = calc.chance(c);
    expect(Math.abs(ok / n - chance)).toBeLessThan(0.05);
  });
});

describe("ball physics", () => {
  const ground = { block: (_x: number, y: number) => (y < 69 ? 1 : 0) } as never;

  it("a solved throw lands on its target", () => {
    const v = solveThrow(8, -1, 0, 14)!;
    const b = newBall(0, 70.5, 0, v.vx, v.vy, v.vz);
    let hit = false;
    for (let i = 0; i < 400 && !hit; i++) {
      const px = b.x;
      const py = b.y;
      const pz = b.z;
      stepBall(ground, b, 1 / 60);
      hit = segmentHitsBox(px, py, pz, b.x, b.y, b.z, 7.7, 69, -0.3, 8.3, 69.6, 0.3);
    }
    expect(hit).toBe(true);
  });

  it("a miss bounces, rolls and comes to rest on the ground", () => {
    const b = newBall(0, 70.5, 0, 12, 4, 0);
    const events: string[] = [];
    for (let i = 0; i < 1200 && !b.resting; i++) events.push(...stepBall(ground, b, 1 / 60).map((e) => e.kind));
    expect(events).toContain("bounce");
    expect(b.resting).toBe(true);
    expect(b.y).toBeCloseTo(69 + BALL.radius, 1);
    expect(b.x).toBeGreaterThan(5);
    expect(b.x).toBeLessThan(25);
  });
});

describe("progression", () => {
  it("levels up, learns moves and evolves", () => {
    const rng = new Rng(8);
    const c = createCreature(db, "bulbasaur", 15, rng);
    const events = grantExp(db, c, expForLevel(16) - c.exp);
    expect(c.level).toBe(16);
    expect(events.some((e) => e.t === "level")).toBe(true);
    const evo = evolveIfReady(db, c);
    expect(evo?.t).toBe("evolve");
    expect(c.species).toBe("ivysaur");
    expect(c.hp).toBeLessThanOrEqual(maxHp(db, c));
  });
});
