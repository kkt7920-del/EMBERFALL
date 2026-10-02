import { describe, expect, it } from "vitest";
import { SEA_LEVEL } from "@shared/config/constants";
import { ContentDB } from "@shared/data/contentDb";
import { Rng } from "@shared/math/rng";
import { PokemonSpeciesRegistry } from "@shared/pokemon/PokemonSpeciesRegistry";
import { BIOMES, Block, SOLID } from "@shared/world/blocks";
import { TerrainGenerator } from "@shared/world/generator";
import { clockAt } from "@shared/world/time";
import { VoxelWorld } from "@shared/world/voxelWorld";
import { moveBody } from "@shared/world/physics";
import { db } from "./helpers";

describe("content pack", () => {
  it("loads real Pokémon species with valid references", () => {
    expect(db.species.size).toBeGreaterThanOrEqual(100);
    expect(db.validate()).toEqual([]);
    const reg = new PokemonSpeciesRegistry(db);
    const pikachu = reg.require("pikachu");
    expect(pikachu.dexNumber).toBe(25);
    expect(pikachu.name).toBe("Pikachu");
    expect(pikachu.types).toEqual(["electric"]);
    expect(reg.dex(6)?.id).toBe("charizard");
    // Every species names a model slot (the asset may be missing) and moves on land, water or air
    for (const s of reg.all()) {
      expect(s.modelId).toBeTruthy();
      expect(s.movement.land || s.movement.water || s.movement.underwater || s.movement.air).toBe(true);
      expect(s.hitbox.width).toBeGreaterThan(0);
    }
  });

  it("reports broken references instead of loading them", () => {
    expect(() => ContentDB.fromFiles({ "content/pokemon/species/0999_x.json": { id: "x", name: "X", dexNumber: 999, types: ["nope"], learnset: [] } })).toThrow();
  });

  it("keeps every capture coefficient in data", () => {
    expect(db.balls.get("poke_ball")).toBeTruthy();
    for (const id of ["great_ball", "ultra_ball", "quick_ball", "dive_ball", "dusk_ball", "net_ball", "timer_ball", "repeat_ball"]) expect(db.balls.has(id)).toBe(true);
    expect(db.capture!.shakeChecks).toBeGreaterThanOrEqual(3);
  });
});

describe("voxel terrain", () => {
  const region = db.defaultRegion();
  const gen = new TerrainGenerator(region);
  const at = (x: number, z: number) => {
    const c = gen.column(x, z);
    return { ...c, biomeName: BIOMES[c.biome] };
  };

  it("is deterministic", () => {
    const other = new TerrainGenerator(region);
    for (const [x, z] of [[3, 7], [-200, 40], [250, 110], [40, -350], [-420, 540]]) expect(other.column(x, z).h).toBe(at(x, z).h);
    const a = gen.generateBox(-16, -16, 20, 20);
    const b = other.generateBox(-16, -16, 20, 20);
    expect(Buffer.from(a.blocks).equals(Buffer.from(b.blocks))).toBe(true);
  });

  it("lays out the first region", () => {
    expect(at(0, 0).biomeName).toBe("town");
    expect(at(-80, 240).biomeName).toMatch(/forest/);
    expect(at(252, 112).biomeName).toBe("lake");
    expect(at(40, -262).biomeName).toMatch(/beach|coast/);
    expect(at(60, -430).biomeName).toMatch(/sea|ocean/);
    expect(at(100, -600).biomeName).toBe("deep_ocean");
    expect(at(100, -720).biomeName).toBe("abyss");
    expect(at(440, 540).biomeName).toBe("volcano");
    expect(at(-420, 540).h).toBeGreaterThan(160);
    expect(at(-420, 540).biomeName).toMatch(/mountain/);
  });

  it("ocean floor gets deeper away from the coast", () => {
    const shallow = at(40, -320).h;
    const deep = at(100, -720).h;
    expect(shallow).toBeLessThan(SEA_LEVEL);
    expect(deep).toBeLessThan(shallow - 20);
  });

  it("rivers run downhill from the mountains to the sea", () => {
    const river = region.rivers.find((r) => r.id === "silver_river")!;
    const levels = river.points.map(([x, z]) => gen.column(x, z).water).filter((w) => w > 0);
    expect(levels.length).toBeGreaterThan(4);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThanOrEqual(levels[i - 1]);
    expect(levels[0]).toBeGreaterThan(levels[levels.length - 1] + 30);
  });

  it("carves the cave system and connects its entrance to the surface", () => {
    const cave = region.caves.find((c) => c.id === "echo_cave")!;
    // Entrance just below the hillside surface, then tunnels deep under it
    for (const [x, y, z] of cave.path.slice(1, 4) as [number, number, number][]) {
      const box = gen.generateBox(x - 2, z - 2, 5, 5);
      expect(box.get(x, y, z)).toBe(Block.AIR);
    }
    const [x, y, z] = cave.path[3] as [number, number, number];
    expect(gen.column(x, z).h - y).toBeGreaterThan(15);
    expect(gen.undergroundBiome(x, y, z, gen.column(x, z).h)).toMatch(/cave|cavern/);
  });

  it("generated chunks are made of 1x1x1 blocks with grass on top in the plains", () => {
    const box = gen.generateBox(20, 30, 8, 8);
    const h = box.surface[0];
    expect(SOLID[box.get(20, h, 30)]).toBe(1);
    expect(SOLID[box.get(20, h + 1, 30)]).toBe(0);
    expect(box.get(20, h, 30)).toBe(Block.GRASS);
  });
});

describe("voxel world + physics", () => {
  const world = new VoxelWorld(new TerrainGenerator(db.defaultRegion()));

  it("answers block queries and raycasts", () => {
    const top = world.surfaceHeight(20.5, 30.5);
    expect(world.solid(20, top, 30)).toBe(true);
    const hit = world.raycast(20.5, top + 10, 30.5, 0, -1, 0, 20);
    expect(hit?.y).toBe(top);
  });

  it("bodies land on the ground and cannot walk through walls", () => {
    const top = world.surfaceHeight(20.5, 30.5);
    const body = { x: 20.5, y: top + 6, z: 30.5, halfW: 0.3, height: 1.8 };
    for (let i = 0; i < 100; i++) moveBody(world, body, 0, -0.2, 0, 0.6);
    expect(body.y).toBeCloseTo(top + 1, 3);
    // A building wall in town: walking into it stops at the wall
    const wallTest = { x: 0.5, y: world.surfaceHeight(0.5, 19.5) + 1, z: 19.5, halfW: 0.3, height: 1.8 };
    for (let i = 0; i < 60; i++) moveBody(world, wallTest, 0, 0, 0.2, 0.6);
    for (let y = Math.floor(wallTest.y); y < wallTest.y + 1.8; y++) expect(world.solid(Math.floor(wallTest.x), y, Math.floor(wallTest.z))).toBe(false);
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
