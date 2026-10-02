import type { RegionDef } from "@shared/types/content";
import { type HeightSource, WorldTerrain, groundUnder, newColumn } from "@shared/world/terrain";

/**
 * Main-thread terrain queries for physics and placement (the render meshes
 * come from the worker). Same deterministic generator as the server, so the
 * client predicts collisions exactly as the server validates them.
 */
export class ClientTerrain {
  readonly world: WorldTerrain;
  private readonly caches = new Map<string, Map<number, number>>();
  private readonly col = newColumn();

  constructor(region: RegionDef) {
    this.world = new WorldTerrain(region);
  }

  height(zone: string, x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    let cache = this.caches.get(zone);
    if (!cache) this.caches.set(zone, (cache = new Map()));
    const key = (ix + 32768) * 65536 + (iz + 32768);
    let h = cache.get(key);
    if (h === undefined) {
      h = this.world.zone(zone).column(ix, iz, this.col).h;
      if (cache.size > 60000) cache.clear();
      cache.set(key, h);
    }
    return h;
  }

  source(zone: string): HeightSource {
    return { height: (x, z) => this.height(zone, x, z) };
  }

  ground(zone: string, x: number, z: number, radius: number): number {
    return groundUnder(this.source(zone), x, z, radius);
  }

  waterLevel(zone: string): number | null {
    return this.world.zone(zone).waterLevel;
  }

  ceiling(zone: string): number | null {
    return this.world.zone(zone).ceiling;
  }

  bounds(zone: string) {
    return this.world.zone(zone).bounds;
  }
}
