import { CHUNK_SIZE } from "@shared/config/constants";

export interface Spatial {
  id: string;
  zone: string;
  x: number;
  z: number;
}

/**
 * Chunk-bucketed index. Lookups only touch the chunks overlapping the query
 * circle, so cost depends on local density, never on the world total.
 */
export class SpatialIndex<T extends Spatial> {
  private readonly cells = new Map<string, Set<T>>();
  private readonly cellOf = new Map<string, string>();

  private key(zone: string, x: number, z: number): string {
    return `${zone}|${Math.floor(x / CHUNK_SIZE)}|${Math.floor(z / CHUNK_SIZE)}`;
  }

  upsert(e: T): void {
    const k = this.key(e.zone, e.x, e.z);
    const prev = this.cellOf.get(e.id);
    if (prev === k) return;
    if (prev) this.cells.get(prev)?.delete(e);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = new Set()));
    cell.add(e);
    this.cellOf.set(e.id, k);
  }

  remove(e: T): void {
    const prev = this.cellOf.get(e.id);
    if (prev) {
      const cell = this.cells.get(prev);
      cell?.delete(e);
      if (cell && cell.size === 0) this.cells.delete(prev);
    }
    this.cellOf.delete(e.id);
  }

  query(zone: string, x: number, z: number, radius: number, out: T[] = []): T[] {
    const minCx = Math.floor((x - radius) / CHUNK_SIZE);
    const maxCx = Math.floor((x + radius) / CHUNK_SIZE);
    const minCz = Math.floor((z - radius) / CHUNK_SIZE);
    const maxCz = Math.floor((z + radius) / CHUNK_SIZE);
    const r2 = radius * radius;
    for (let cx = minCx; cx <= maxCx; cx++)
      for (let cz = minCz; cz <= maxCz; cz++) {
        const cell = this.cells.get(`${zone}|${cx}|${cz}`);
        if (!cell) continue;
        for (const e of cell) {
          const dx = e.x - x;
          const dz = e.z - z;
          if (dx * dx + dz * dz <= r2) out.push(e);
        }
      }
    return out;
  }

  count(zone: string, x: number, z: number, radius: number): number {
    return this.query(zone, x, z, radius).length;
  }

  get size(): number {
    return this.cellOf.size;
  }
}
