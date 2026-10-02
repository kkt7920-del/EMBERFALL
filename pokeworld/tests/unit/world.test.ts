import { describe, expect, it } from "vitest";
import { SEA_LEVEL } from "@shared/config/constants";
import { ContentDB } from "@shared/data/contentDb";
import { Rng } from "@shared/math/rng";
import { BIOMES } from "@shared/world/blocks";
import { WorldTerrain, newColumn } from "@shared/world/terrain";
import { clockAt } from "@shared/world/time";
import { db } from "./helpers";

describe("content pack", () => {
  it("loads 30+ placeholder species with valid references", () => {
    expect(db.species.size).toBeGreaterThanOrEqual(30);
    expect(db.validate()).toEqual([]);
    expect(db.defaultRegion().ruins.map((r) => r.id)).toContain("dawn_ruins");
  });

  it("reports broken references instead of loading them", () => {
    expect(() =>
      ContentDB.fromFiles({ "content/species/x.json": { id: "x", name: "X", types: ["nope"], learnset: [] } }),
    ).toThrow(/unknown type nope/);
  });
});

describe("terrain", () => {
  const terrain = new WorldTerrain(db.defaultRegion());
  const col = newColumn();
  const at = (x: number, z: number, zone = "overworld") => {
    terrain.zone(zone).column(x, z, col);
    return { ...col, biomeName: BIOMES[col.biome] };
  };

  it("is deterministic", () => {
    const a = new WorldTerrain(db.defaultRegion());
    for (const [x, z] of [[3, 7], [-200, 40], [250, 110], [40, -350]]) {
      expect(a.overworld.column(x, z).h).toBe(at(x, z).h);
    }
  });

  it("lays out the starter region", () => {
    expect(at(0, 0).biomeName).toBe("town");
    expect(at(-80, 240).biomeName).toBe("forest");
    expect(at(252, 112).biomeName).toBe("lake");
    expect(at(40, -350).biomeName).toMatch(/ocean/);
    expect(at(76, 0).biomeName).toBe("river");
    expect(at(76, 0).h).toBeLessThan(SEA_LEVEL);
    expect(at(230, 272).biomeName).toBe("ruins");
    expect(at(80, 12, "cave:echo_cave").biomeName).toBe("cave");
    expect(at(82, 144, "cave:echo_cave").h).toBeLessThan(20);
  });

  it("buildings are solid and taller than the town floor", () => {
    expect(at(-22, 10).h).toBeGreaterThan(at(-22, 0).h + 4);
  });
});

describe("clock", () => {
  it("starts in the morning and cycles periods", () => {
    expect(clockAt(0, "clear").period).toBe("day");
    const night = clockAt((14 / 24) * 1200, "clear");
    expect(night.hour).toBeCloseTo(22, 0);
    expect(night.period).toBe("night");
  });
});

describe("rng", () => {
  it("is reproducible", () => {
    const a = new Rng(42);
    const b = new Rng(42);
    expect([a.next(), a.next(), a.int(1, 6)]).toEqual([b.next(), b.next(), b.int(1, 6)]);
  });
});
