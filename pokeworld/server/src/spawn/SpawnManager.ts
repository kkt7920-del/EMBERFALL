import { SPAWN_MAX_DISTANCE, SPAWN_MIN_DISTANCE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { createCreature } from "@shared/data/stats";
import { type Rng, randomId } from "@shared/math/rng";
import type { Layer, MovementMode, SpawnRuleDef } from "@shared/types/content";
import type { WorldClock } from "@shared/types/game";
import type { Player } from "../player/Player";
import { WildCreature } from "../pokemon/WildCreature";
import type { World } from "../world/World";

export interface SpawnSpot {
  zone: string;
  x: number;
  z: number;
  biome: string;
  layers: Layer[];
  altitude: number;
  waterDepth: number;
}

/** Data-driven spawning: rules from content/spawns are matched against the spot, time, weather and the player's progress. */
export class SpawnManager {
  constructor(
    private readonly db: ContentDB,
    private readonly world: World,
  ) {}

  rulesFor(spot: SpawnSpot, layer: Layer, clock: WorldClock, player: Player): SpawnRuleDef[] {
    const done = player.save.quests.completed;
    return this.db.spawns.filter(
      (r) =>
        (r.zone ?? "overworld") === spot.zone &&
        (r.layer ?? "land") === layer &&
        r.biomes.includes(spot.biome) &&
        (!r.time || r.time.includes(clock.period)) &&
        (!r.weather || r.weather.includes(clock.weather)) &&
        (!r.altitude || (spot.altitude >= r.altitude.min && spot.altitude <= r.altitude.max)) &&
        (!r.waterDepth || (spot.waterDepth >= r.waterDepth.min && spot.waterDepth <= r.waterDepth.max)) &&
        (!r.quest || done.includes(r.quest)) &&
        (!r.structure || this.world.structureDistance(r.structure.id, spot.x, spot.z) <= r.structure.radius) &&
        (!r.progression?.minCaught || player.save.caught.length >= r.progression.minCaught),
    );
  }

  /** One spawn attempt around the player. Returns the new creature or null. */
  trySpawn(player: Player, clock: WorldClock, rng: Rng, now: number): WildCreature | null {
    const zone = player.zone;
    const w = this.world;

    for (let attempt = 0; attempt < 4; attempt++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(SPAWN_MIN_DISTANCE, SPAWN_MAX_DISTANCE);
      const x = player.x + Math.cos(a) * r;
      const z = player.z + Math.sin(a) * r;
      if (!w.inBounds(zone, x, z, 3)) continue;

      const h = w.height(zone, x, z);
      // Skip tree trunks, walls and pillars: much taller than their neighbours
      if (Math.abs(h - w.height(zone, x + 1.5, z)) > 2 || Math.abs(h - w.height(zone, x, z + 1.5)) > 2) continue;

      const spot: SpawnSpot = {
        zone,
        x,
        z,
        biome: w.biome(zone, x, z),
        layers: w.layersAt(zone, x, z),
        altitude: h,
        waterDepth: w.waterDepth(zone, x, z),
      };

      const layer = rng.pick(spot.layers);
      const rule = rng.weighted(this.rulesFor(spot, layer, clock, player), (s) => s.weight);
      if (!rule) continue;

      const level = rng.int(rule.level.min, rule.level.max);
      const creature = createCreature(this.db, rule.species, level, rng);
      const mode: MovementMode = layer === "air" ? "fly" : layer === "water_surface" ? "swim" : "walk";
      const species = this.db.species.get(rule.species)!;

      let y: number;
      if (mode === "swim") y = w.swimHeight(zone);
      else if (mode === "fly") {
        y = Math.max(h, w.waterLevel(zone) ?? h) + 7;
        const ceiling = w.ceiling(zone);
        if (ceiling !== null) y = Math.min(y, ceiling - 1.5);
      } else y = w.ground(zone, x, z, 0.3);

      return new WildCreature(randomId("w_", rng), creature, species, zone, x, y, z, rng.range(-Math.PI, Math.PI), mode, { x, z }, now, rule.id);
    }
    return null;
  }
}
