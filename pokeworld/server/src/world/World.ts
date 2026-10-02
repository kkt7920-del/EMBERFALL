import { SEA_LEVEL } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { dist2 } from "@shared/math/vec";
import type { AreaDef, InteractableDef, Layer, NpcDef, RegionDef } from "@shared/types/content";
import type { BiomeName } from "@shared/world/blocks";
import { OVERWORLD, TerrainCache, WorldTerrain, caveZoneId, groundUnder } from "@shared/world/terrain";

/** Server-side view of the region: cached terrain queries plus static NPCs, objects and areas. */
export class World {
  readonly region: RegionDef;
  readonly terrain: WorldTerrain;
  private readonly caches = new Map<string, TerrainCache>();

  constructor(readonly db: ContentDB) {
    this.region = db.defaultRegion();
    this.terrain = new WorldTerrain(this.region);
    for (const id of this.terrain.zoneIds()) this.caches.set(id, new TerrainCache(this.terrain.zone(id)));
  }

  cache(zone: string): TerrainCache {
    const c = this.caches.get(zone);
    if (!c) throw new Error(`unknown zone ${zone}`);
    return c;
  }

  hasZone(zone: string): boolean {
    return this.caches.has(zone);
  }

  height(zone: string, x: number, z: number): number {
    return this.cache(zone).height(x, z);
  }

  /** Feet height for a body of the given radius standing at x/z. */
  ground(zone: string, x: number, z: number, radius = 0.3): number {
    return groundUnder(this.cache(zone), x, z, radius);
  }

  biome(zone: string, x: number, z: number): BiomeName {
    return this.cache(zone).biome(x, z);
  }

  waterLevel(zone: string): number | null {
    return this.terrain.zone(zone).waterLevel;
  }

  /** Metres of water above the ground (0 on land or in dry zones). */
  waterDepth(zone: string, x: number, z: number): number {
    const level = this.waterLevel(zone);
    if (level === null) return 0;
    return Math.max(0, level - this.height(zone, x, z));
  }

  inBounds(zone: string, x: number, z: number, margin = 0): boolean {
    const b = this.terrain.zone(zone).bounds;
    if (!b) return true;
    return x >= b.minX + margin && z >= b.minZ + margin && x <= b.maxX - margin && z <= b.maxZ - margin;
  }

  ceiling(zone: string): number | null {
    return this.terrain.zone(zone).ceiling;
  }

  /** Which traversal layers a spot supports. */
  layersAt(zone: string, x: number, z: number): Layer[] {
    const depth = this.waterDepth(zone, x, z);
    const layers: Layer[] = ["air"];
    if (depth >= 1.2) layers.push("water_surface");
    else if (depth === 0) layers.push("land");
    return layers;
  }

  npc(id: string): NpcDef | undefined {
    return this.region.npcs.find((n) => n.id === id);
  }

  interactable(id: string): InteractableDef | undefined {
    return this.region.interactables.find((i) => i.id === id);
  }

  zoneOfNpc(n: NpcDef): string {
    return n.zone ?? OVERWORLD;
  }

  zoneOfInteractable(i: InteractableDef): string {
    return i.zone ?? OVERWORLD;
  }

  areasAt(zone: string, x: number, z: number): AreaDef[] {
    return this.region.areas.filter((a) => (a.zone ?? OVERWORLD) === zone && dist2(x, z, a.x, a.z) <= a.radius);
  }

  /** Where the player stands after leaving a cave: a few metres out of the arch. */
  caveExitPoint(caveId: string): { x: number; z: number } {
    const cave = this.region.caves.find((c) => c.id === caveId);
    if (!cave) throw new Error(`unknown cave ${caveId}`);
    const f = this.terrain.overworld.caveFacing(cave);
    return { x: cave.entrance.x + f.x * 6 + 0.5, z: cave.entrance.z + f.z * 6 + 0.5 };
  }

  caveStart(caveId: string): { zone: string; x: number; z: number } {
    const cave = this.region.caves.find((c) => c.id === caveId);
    if (!cave) throw new Error(`unknown cave ${caveId}`);
    return { zone: caveZoneId(cave.id), x: cave.start.x + 0.5, z: cave.start.z + 4.5 };
  }

  structureDistance(id: string, x: number, z: number): number {
    const ruin = this.region.ruins.find((r) => r.id === id);
    if (ruin) return dist2(x, z, ruin.x, ruin.z);
    const b = this.region.buildings.find((r) => r.id === id);
    if (b) return dist2(x, z, b.x, b.z);
    return Infinity;
  }

  /** Surface height a swimmer floats at. */
  swimHeight(zone: string): number {
    return (this.waterLevel(zone) ?? SEA_LEVEL) - 0.45;
  }
}
