import { SPAWN_MAX_DISTANCE, SPAWN_MIN_DISTANCE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { createCreature } from "@shared/data/stats";
import { type Rng, randomId } from "@shared/math/rng";
import type { Layer, SpawnRuleDef } from "@shared/types/content";
import type { WildMode, WorldClock } from "@shared/types/game";
import { Block, UNDERGROUND_BIOMES } from "@shared/world/blocks";
import { COL_CLIFF, COL_WATERFALL, newColumnInfo } from "@shared/world/column";
import type { Player } from "../player/Player";
import { WildCreature } from "../pokemon/WildCreature";
import { OVERWORLD, type World } from "../world/World";

export interface SpawnSpot {
  x: number;
  y: number;
  z: number;
  biome: string;
  subBiomes: string[];
  layer: Layer;
  altitude: number;
  waterDepth: number;
}

/**
 * Data-driven spawning: rules from content/spawns are matched against the
 * spot (biome, sub-biome, layer, altitude, water depth), time, weather and
 * the player's progress. Underground players get cave spawns near their own
 * height; surface players get surface, water and sky spawns.
 */
export class SpawnManager {
  private readonly col = newColumnInfo();

  constructor(
    private readonly db: ContentDB,
    private readonly world: World,
  ) {}

  rulesFor(spot: SpawnSpot, clock: WorldClock, player: Player): SpawnRuleDef[] {
    const done = player.save.quests.completed;
    const region = this.world.region.id;
    return this.db.spawns.filter(
      (r) =>
        (!r.region || r.region === region) &&
        (r.layer ?? "land") === spot.layer &&
        r.biomes.includes(spot.biome) &&
        (!r.subBiomes || r.subBiomes.some((s) => spot.subBiomes.includes(s))) &&
        (!r.time || r.time.includes(clock.period)) &&
        (!r.weather || r.weather.includes(clock.weather)) &&
        (!r.altitude || (spot.altitude >= r.altitude.min && spot.altitude <= r.altitude.max)) &&
        (!r.waterDepth || (spot.waterDepth >= r.waterDepth.min && spot.waterDepth <= r.waterDepth.max)) &&
        (!r.quest || done.includes(r.quest)) &&
        (!r.structure || this.world.structureDistance(r.structure.id, spot.x, spot.z) <= r.structure.radius) &&
        (!r.progression?.minCaught || player.save.caught.length >= r.progression.minCaught),
    );
  }

  /** Terrain features around a spot that finer spawn rules can ask for. */
  subBiomesAt(x: number, y: number, z: number, biome: string): string[] {
    const out: string[] = [];
    const w = this.world;
    const gen = w.gen;
    const c = gen.column(Math.floor(x), Math.floor(z), this.col);
    if (c.flags & COL_CLIFF) out.push("cliff");
    // Waterfall spray reaches a few blocks
    for (const [dx, dz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
      if (gen.column(Math.floor(x + dx), Math.floor(z + dz), this.col).flags & COL_WATERFALL) {
        out.push("waterfall");
        break;
      }
    }
    if (w.waterDepth(x, z) === 0) {
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]])
        if (w.waterDepth(x + dx, z + dz) > 0.5) {
          out.push("riverbank");
          break;
        }
    }
    if (biome === "plains" || biome === "forest_edge") {
      if (gen.n.noise2(x / 60, z / 60) > 0.2) out.push("flower_field");
      out.push("meadow");
    }
    if (biome === "forest" || biome === "deep_forest") {
      let logs = 0;
      for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3], [-3, -3]])
        for (let dy = 1; dy <= 3; dy++) {
          const b = w.block(x + dx, y + dy, z + dz);
          if (b === Block.OAK_LOG || b === Block.JUNGLE_LOG || b === Block.BIRCH_LOG || b === Block.PINE_LOG) logs++;
        }
      if (logs === 0) out.push("clearing", "meadow");
    }
    if (biome === "shallow_sea" || biome === "coast") {
      for (const [dx, dz] of [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
        const top = gen.column(Math.floor(x + dx), Math.floor(z + dz), this.col).h + 1;
        const b = w.block(x + dx, top, z + dz);
        if (b >= Block.CORAL_RED && b <= Block.CORAL_PINK) {
          out.push("reef");
          break;
        }
      }
    }
    if (biome === "volcano") {
      for (const v of w.region.volcanoes) if (Math.hypot(x - v.x, z - v.z) < v.crater + 12) out.push("crater");
    }
    if (y > 185) out.push("summit");
    return out;
  }

  /** One spawn attempt around the player. Returns the new Pokémon or null. */
  trySpawn(player: Player, clock: WorldClock, rng: Rng, now: number, occupied: (x: number, z: number, r: number) => boolean): WildCreature | null {
    const w = this.world;
    const vox = w.voxels;
    const underground = !vox.skyVisible(player.x, player.y + 1.8, player.z) && player.y < vox.surfaceHeight(player.x, player.z) - 4;

    for (let attempt = 0; attempt < 5; attempt++) {
      const a = rng.range(0, Math.PI * 2);
      const r = underground ? rng.range(8, 26) : rng.range(SPAWN_MIN_DISTANCE, SPAWN_MAX_DISTANCE);
      const x = player.x + Math.cos(a) * r;
      const z = player.z + Math.sin(a) * r;

      let spot: SpawnSpot | null = null;
      if (underground) {
        const feet = w.floorNear(x, player.y + 4, z, 2, 2, 14);
        if (feet === null || vox.skyVisible(x, feet + 1, z)) continue;
        const biome = w.biomeAt(x, feet, z);
        if (!UNDERGROUND_BIOMES.includes(biome as never)) continue;
        const wet = w.inWater(x, feet, z);
        const layer: Layer = wet ? "water_surface" : rng.next() < 0.25 ? "air" : "land";
        const y = wet ? (w.waterSurface(x, feet, z) ?? feet) : layer === "air" ? feet + 2 : feet;
        spot = { x, y, z, biome, subBiomes: [], layer, altitude: Math.floor(y), waterDepth: wet ? 1 : 0 };
      } else {
        const top = vox.topSolid(x, z);
        if (top < 0) continue;
        const waterTop = vox.waterTop(x, z);
        const water = waterTop >= 0 && vox.block(x, waterTop, z) === Block.WATER ? waterTop : -1;
        const depth = water >= 0 ? w.waterDepth(x, z) : 0;
        const biome = w.biomeAt(x, top + 1, z);
        const layers: Layer[] = ["air"];
        if (depth >= 1.5) layers.push("water_surface", "water_surface");
        if (depth >= 4) layers.push("underwater", "underwater");
        if (depth === 0) layers.push("land", "land", "land");
        const layer = rng.pick(layers);
        // Skip tree tops, roofs and pillars: land spawns need a natural surface
        if (layer === "land") {
          const ground = vox.block(x, top, z);
          if (ground === Block.OAK_LEAVES || ground === Block.PINE_LEAVES || ground === Block.JUNGLE_LEAVES || ground === Block.BIRCH_LEAVES) continue;
          if (ground >= Block.ROOF_RED && ground <= Block.ROOF_ORANGE) continue;
          if (top > vox.surfaceHeight(x, z) + 4) continue;
        }
        let y = top + 1;
        if (layer === "water_surface") y = water + 1;
        else if (layer === "underwater") y = rng.range(top + 1.5, water - 1.5);
        else if (layer === "air") y = Math.max(top, water) + rng.range(3, 8);
        spot = { x, y, z, biome, subBiomes: this.subBiomesAt(x, top + 1, z, biome), layer, altitude: Math.floor(y), waterDepth: depth };
      }
      if (!spot) continue;

      const rule = rng.weighted(this.rulesFor(spot, clock, player), (s) => s.weight);
      if (!rule) continue;
      const species = this.db.species.get(rule.species)!;
      const alpha = !species.legendary && rng.next() < (rule.alphaChance ?? 0);
      const level = Math.min(100, rng.int(rule.level.min, rule.level.max) + (alpha ? 5 : 0));
      const creature = createCreature(this.db, rule.species, level, rng, { alpha });
      creature.origin = this.areaName(spot.x, spot.y, spot.z) ?? spot.biome;
      const width = species.hitbox.width * creature.size;
      const height = species.hitbox.height * creature.size;
      if (occupied(spot.x, spot.z, Math.max(5, width * 2 + 3))) continue;

      let mode: WildMode = spot.layer === "air" ? "fly" : spot.layer === "water_surface" ? "swim" : spot.layer === "underwater" ? "dive" : "walk";
      let y = spot.y;
      if (mode === "walk") {
        const feet = w.floorNear(spot.x, spot.y, spot.z, Math.max(1, Math.ceil(height)), 1, 2);
        if (feet === null) continue;
        y = feet;
      } else if (mode === "swim") {
        y = spot.y - Math.min(0.7, height * 0.45);
      } else if (mode === "dive") {
        if (w.block(spot.x, spot.y + height, spot.z) !== Block.WATER) y = spot.y - height;
      } else if (mode === "fly") {
        let clear = true;
        for (let k = 0; k <= Math.ceil(height); k++) if (w.solid(spot.x, y + k, spot.z)) clear = false;
        if (!clear) continue;
      }
      if (!species.movement.land && mode === "walk") mode = species.movement.air ? "fly" : mode;

      return new WildCreature(
        randomId("w_", rng),
        creature,
        species,
        OVERWORLD,
        spot.x,
        y,
        spot.z,
        rng.range(-Math.PI, Math.PI),
        mode,
        { x: spot.x, y, z: spot.z },
        now,
        rule.id,
        undefined,
        undefined,
        rule.rarity,
      );
    }
    return null;
  }

  areaName(x: number, y: number, z: number): string | undefined {
    const areas = this.world.areasAt(x, y, z).sort((a, b) => a.radius - b.radius);
    return areas[0]?.name;
  }
}
