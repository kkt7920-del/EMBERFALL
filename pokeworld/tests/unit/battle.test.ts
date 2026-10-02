import { describe, expect, it } from "vitest";
import { createCreature, expForLevel, maxHp } from "@shared/data/stats";
import { Rng } from "@shared/math/rng";
import { Battle } from "@server/battle/Battle";
import { rollCapture } from "@server/battle/capture";
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
    const fire = createCreature(db, "emberpup", 10, rng);
    const grass = createCreature(db, "leafbun", 10, rng);
    const water = createCreature(db, "dropnewt", 10, rng);
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
    const mouse = createCreature(db, "sparkmouse", 10, rng);
    const mud = createCreature(db, "mudpup", 10, rng);
    expect(computeDamage(db, mouse, freshStages(), mud, freshStages(), spark, rng).damage).toBe(0);
  });
});

describe("battle flow", () => {
  it("a stronger partner wins a wild battle and gains exp", () => {
    const rng = new Rng(3);
    const party = [createCreature(db, "blazehound", 30, rng)];
    const foe = createCreature(db, "meadowbug", 3, rng);
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
    const party = [createCreature(db, "meadowbug", 2, rng), createCreature(db, "meadowbug", 2, rng)];
    const foe = createCreature(db, "ancientguard", 40, rng);
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

  it("rejects capture and running in guardian battles", () => {
    const rng = new Rng(5);
    const party = [createCreature(db, "blazehound", 30, rng)];
    const foe = createCreature(db, "ancientguard", 5, rng);
    const b = new Battle(db, rng, { id: "b", kind: "guardian", playerId: "p", party, foes: [foe], canCapture: false, canRun: false });
    expect(b.act({ kind: "capture", item: "capture_orb" }, inv({ capture_orb: 3 }))).toHaveProperty("error");
    expect(b.act({ kind: "run" }, inv({}))).toHaveProperty("error");
  });

  it("healing items are consumed from the inventory", () => {
    const rng = new Rng(6);
    const party = [createCreature(db, "leafbun", 10, rng)];
    party[0].hp = 5;
    const foe = createCreature(db, "meadowbug", 2, rng);
    const b = new Battle(db, rng, { id: "b", kind: "wild", playerId: "p", party, foes: [foe], canCapture: true, canRun: true });
    const items = { potion: 1 };
    const r = b.act({ kind: "item", item: "potion", target: 0 }, inv(items));
    if ("error" in r) throw new Error(r.error);
    expect(items.potion).toBe(0);
    expect(b.act({ kind: "item", item: "potion", target: 0 }, inv(items))).toHaveProperty("error");
  });
});

describe("capture", () => {
  it("is easier at low HP and with better orbs", () => {
    const rng = new Rng(7);
    const c = createCreature(db, "sparkmouse", 5, rng);
    const full = rollCapture(db, c, 1, rng).chance;
    const great = rollCapture(db, c, 1.5, rng).chance;
    c.hp = 1;
    const low = rollCapture(db, c, 1, rng).chance;
    expect(great).toBeGreaterThan(full);
    expect(low).toBeGreaterThan(full);
  });
});

describe("progression", () => {
  it("levels up, learns moves and evolves", () => {
    const rng = new Rng(8);
    const c = createCreature(db, "leafbun", 15, rng);
    const events = grantExp(db, c, expForLevel(16) - c.exp);
    expect(c.level).toBe(16);
    expect(events.some((e) => e.t === "level")).toBe(true);
    const evo = evolveIfReady(db, c);
    expect(evo?.t).toBe("evolve");
    expect(c.species).toBe("thornhare");
    expect(c.hp).toBeLessThanOrEqual(maxHp(db, c));
  });
});
