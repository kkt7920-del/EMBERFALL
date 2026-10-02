import { SEA_LEVEL } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { dist2 } from "@shared/math/vec";
import type { AreaDef, InteractableDef, Layer, NpcDef, RegionDef } from "@shared/types/content";
import { Block, type BiomeName, LIGHT, SOLID } from "@shared/world/blocks";
import { TerrainGenerator } from "@shared/world/generator";
import { VoxelWorld } from "@shared/world/voxelWorld";

export { OVERWORLD } from "@shared/world/zone";
import { OVERWORLD } from "@shared/world/zone";

/**
 * Server-side view of the region: the voxel world (generated on demand,
 * or shared with the client renderer in single player) plus static NPCs,
 * objects and areas.
 */
export class World {
  readonly region: RegionDef;
  readonly voxels: VoxelWorld;

  constructor(
    readonly db: ContentDB,
    voxels?: VoxelWorld,
  ) {
    this.region = db.defaultRegion();
    this.voxels = voxels ?? new VoxelWorld(new TerrainGenerator(this.region), 256);
  }

  get gen(): TerrainGenerator {
    return this.voxels.gen;
  }

  hasZone(zone: string): boolean {
    return zone === OVERWORLD;
  }

  block(x: number, y: number, z: number): number {
    return this.voxels.block(x, y, z);
  }

  solid(x: number, y: number, z: number): boolean {
    return SOLID[this.voxels.block(x, y, z)] === 1;
  }

  /** Feet height on the top surface of a column (for spawning at the surface, respawn points). */
  surfaceFeet(x: number, z: number): number {
    return this.voxels.topSolid(x, z) + 1;
  }

  /** Feet height near `y` where a body of `height` fits, or null. */
  floorNear(x: number, y: number, z: number, height = 1.8, maxRise = 1, maxDrop = 6): number | null {
    return this.voxels.floorNear(x, y, z, Math.max(1, Math.ceil(height)), maxRise, maxDrop);
  }

  biomeAt(x: number, y: number, z: number): BiomeName {
    return this.voxels.biomeAt(x, y, z);
  }

  /** Top of the water the point is in, or null. */
  waterSurface(x: number, y: number, z: number): number | null {
    return this.voxels.waterSurfaceAt(x, y, z);
  }

  /** Metres of water above the floor at this column (0 on land). */
  waterDepth(x: number, z: number): number {
    const top = this.voxels.waterTop(x, z);
    if (top < 0 || this.voxels.block(x, top, z) !== Block.WATER) return 0;
    let y = top;
    while (y > 0 && this.voxels.block(x, y, z) === Block.WATER) y--;
    return top - y;
  }

  inWater(x: number, y: number, z: number): boolean {
    return this.voxels.block(x, y, z) === Block.WATER;
  }

  /** Which traversal layers a column supports at the surface. */
  layersAt(x: number, z: number): Layer[] {
    const depth = this.waterDepth(x, z);
    const layers: Layer[] = ["air"];
    if (depth >= 1.5) layers.push("water_surface");
    if (depth >= 4) layers.push("underwater");
    if (depth === 0) layers.push("land");
    return layers;
  }

  /** Rough light level 0..15 at a point (sky if open, else nearby block light). */
  lightLevel(x: number, y: number, z: number, daylight: number): number {
    const sky = this.voxels.skyVisible(x, y + 1, z) ? Math.round(15 * daylight) : 0;
    return Math.max(sky, this.voxels.blockLightNear(x, y, z, 3));
  }

  isEmissive(b: number): boolean {
    return LIGHT[b] > 0;
  }

  npc(id: string): NpcDef | undefined {
    return this.region.npcs.find((n) => n.id === id);
  }

  interactable(id: string): InteractableDef | undefined {
    return this.region.interactables.find((i) => i.id === id);
  }

  /** Feet height of an NPC or object. */
  objectY(o: { x: number; z: number; y?: number }): number {
    if (o.y !== undefined) return o.y + 1;
    return this.surfaceFeet(o.x, o.z);
  }

  areasAt(x: number, y: number, z: number): AreaDef[] {
    return this.region.areas.filter((a) => dist2(x, z, a.x, a.z) <= a.radius && (a.minY === undefined || y >= a.minY) && (a.maxY === undefined || y <= a.maxY));
  }

  structureDistance(id: string, x: number, z: number): number {
    const ruin = this.region.ruins.find((r) => r.id === id);
    if (ruin) return dist2(x, z, ruin.x, ruin.z);
    const b = this.region.buildings.find((r) => r.id === id);
    if (b) return dist2(x, z, b.x, b.z);
    const w = this.region.shipwrecks.find((r) => r.id === id);
    if (w) return dist2(x, z, w.x, w.z);
    return Infinity;
  }

  /** Sea level (used for flying heights over water). */
  get seaLevel(): number {
    return SEA_LEVEL;
  }
}
