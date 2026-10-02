import { CHUNK_SIZE, SEA_LEVEL } from "../config/constants";
import { fbm } from "../math/noise";
import { hash2 } from "../math/rng";
import { clamp, dist2, distToSegment, lerp, smoothstep } from "../math/vec";
import type { CaveDef, RegionDef } from "../types/content";
import { Block, BiomeId, BIOMES, type BiomeName } from "./blocks";

/**
 * One terrain column. The world is a voxel heightmap: every (x, z) metre has a
 * solid column from the bottom up to `h`, with `top` as its surface block and
 * `sub` below. Trees, buildings, ruin pillars and cave walls are tall columns,
 * which gives them collision for free on both client and server.
 */
export interface Column {
  h: number;
  top: number;
  sub: number;
  biome: number;
  /** Trunk height when this column is a tree trunk, else 0. */
  tree: number;
}

export const newColumn = (): Column => ({ h: 0, top: Block.GRASS, sub: Block.DIRT, biome: 0, tree: 0 });

export interface ZoneBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface ZoneTerrain {
  readonly id: string;
  /** Water surface height, or null when the zone has no water. */
  readonly waterLevel: number | null;
  /** Rock ceiling height for underground zones. */
  readonly ceiling: number | null;
  readonly bounds: ZoneBounds | null;
  /** Integer world coordinates. */
  column(x: number, z: number, out?: Column): Column;
}

export const OVERWORLD = "overworld";

export const caveZoneId = (caveId: string): string => `cave:${caveId}`;

interface SpecialColumn {
  h: number;
  top: number;
  sub: number;
}

const ROOF_BLOCK = {
  red: Block.ROOF_RED,
  blue: Block.ROOF_BLUE,
  green: Block.ROOF_GREEN,
  orange: Block.ROOF_ORANGE,
} as const;

const TREE_DENSITY: Partial<Record<BiomeName, number>> = {
  forest: 0.62,
  forest_edge: 0.24,
  grassland: 0.035,
  hills: 0.1,
  island: 0.3,
  wetland: 0.05,
  mountain: 0.07,
};

export class OverworldTerrain implements ZoneTerrain {
  readonly id = OVERWORLD;
  readonly waterLevel = SEA_LEVEL;
  readonly ceiling = null;
  readonly bounds = null;

  private readonly seed: number;
  /** Hand-placed structure columns keyed by "x,z". */
  private readonly special = new Map<string, SpecialColumn>();
  /** Areas where trees never grow (structures, cave arches). */
  private readonly clearings: { x: number; z: number; r: number }[] = [];

  private readonly riverBox: ZoneBounds;
  private readonly roadBoxes: ZoneBounds[];

  constructor(private readonly region: RegionDef) {
    this.seed = region.seed;
    this.riverBox = OverworldTerrain.boxOf(region.river.points, region.river.width + 12);
    this.roadBoxes = region.roads.map((road) => OverworldTerrain.boxOf(road.points, road.width + 4));
    this.buildStructures();
  }

  column(x: number, z: number, out: Column = newColumn()): Column {
    const r = this.region;
    const key = `${x},${z}`;

    const mountain = this.mountainFactor(x, z);
    const hill = this.hillAmount(x, z);
    const forest = this.forestAmount(x, z);

    let h = this.groundFrom(x, z, mountain, hill, forest);
    let biome: BiomeName = "grassland";
    let top: number = Block.GRASS;
    let sub: number = Block.DIRT;
    let structure = false;

    // Hills and mountains decide the biome before water carving
    if (mountain > 0.35) {
      biome = "mountain";
      if (h > 58) {
        top = Block.SNOW;
        sub = Block.STONE;
      } else if (h > 40) {
        top = Block.STONE;
        sub = Block.STONE;
      }
    } else if (hill > 4) {
      biome = "hills";
    }

    // Forests
    if (biome === "grassland" || biome === "hills") {
      if (forest > 0) {
        biome = "forest";
        top = Block.FOREST_GRASS;
      } else if (forest > -0.45) {
        biome = "forest_edge";
      }
    }

    // Coast: south and east of the region is sea
    const shore = this.shoreDistance(x, z);
    if (shore <= 0) {
      const depth = -shore;
      let sea = SEA_LEVEL - 1 - (Math.min(depth, 50) / 50) * 6;
      const deep = smoothstep(60, 170, depth);
      sea = lerp(sea, 3 + fbm(x, z, this.seed + 21, 3, 1 / 40) * 3, deep);
      h = sea;
      biome = depth < 22 ? "coast" : deep > 0.55 ? "deep_ocean" : "ocean";
      top = depth < 30 ? Block.SAND : Block.GRAVEL;
      sub = Block.SAND;

      for (const isl of r.islands) {
        const ir = dist2(x, z, isl.x, isl.z) / isl.radius;
        if (ir < 1.6) {
          const ih = SEA_LEVEL - 1 + ((1.6 - ir) / 1.6) * 8 + (fbm(x, z, this.seed + 31, 2, 1 / 9) - 0.5) * 2;
          if (ih > h) {
            h = ih;
            if (h >= SEA_LEVEL + 1) {
              biome = "island";
              top = h < SEA_LEVEL + 2.5 ? Block.SAND : Block.GRASS;
              sub = h < SEA_LEVEL + 2.5 ? Block.SAND : Block.DIRT;
            }
          }
        }
      }
    } else if (shore < r.coast.beachWidth) {
      const t = smoothstep(0, r.coast.beachWidth, shore);
      h = lerp(SEA_LEVEL + 1, h, t * t);
      if (shore < r.coast.beachWidth * 0.8) {
        biome = "beach";
        top = Block.SAND;
        sub = Block.SAND;
      }
    }

    // River
    const river = this.inBox(this.riverBox, x, z) ? this.polylineDistance(x, z, r.river.points) : Infinity;
    const halfW = river === Infinity ? 0 : (r.river.width / 2) * (0.85 + 0.3 * fbm(x, z, this.seed + 41, 2, 1 / 30));
    if (river < halfW) {
      const q = river / halfW;
      h = Math.min(h, SEA_LEVEL - 1.5 - (1 - q) * 2.5);
      biome = "river";
      top = Block.GRAVEL;
      sub = Block.SAND;
    } else if (river < halfW + 6 && shore > 0) {
      const t = (river - halfW) / 6;
      h = Math.min(h, lerp(SEA_LEVEL + 0.6, h, smoothstep(0, 1, t)));
      if (t < 0.5) {
        biome = "wetland";
        top = h < SEA_LEVEL + 1.2 ? Block.SAND : Block.GRASS;
      }
    }

    // Lakes
    for (const lake of r.lakes) {
      if (Math.abs(x - lake.x) > lake.rx * 1.5 || Math.abs(z - lake.z) > lake.rz * 1.5) continue;
      const q = Math.sqrt(((x - lake.x) / lake.rx) ** 2 + ((z - lake.z) / lake.rz) ** 2) + (fbm(x, z, this.seed + 51, 2, 1 / 20) - 0.5) * 0.15;
      if (q < 1) {
        h = Math.min(h, SEA_LEVEL - 1 - (1 - q) * lake.depth);
        biome = "lake";
        top = Block.CLAY;
        sub = Block.SAND;
      } else if (q < 1.35) {
        h = Math.min(h, lerp(SEA_LEVEL + 0.6, h, (q - 1) / 0.35));
        biome = "wetland";
        top = h < SEA_LEVEL + 1.2 ? Block.SAND : Block.GRASS;
      }
    }

    // Town flattens the ground
    const town = r.town;
    const dTown = dist2(x, z, town.x, town.z);
    if (dTown < town.radius + 24) {
      const t = smoothstep(town.radius, town.radius + 24, dTown);
      h = lerp(town.height, h, t);
      if (dTown < town.radius) {
        biome = "town";
        top = Block.GRASS;
        sub = Block.DIRT;
      }
    }

    // Roads (bridges where they cross water)
    for (let i = 0; i < r.roads.length; i++) {
      const road = r.roads[i];
      if (!this.inBox(this.roadBoxes[i], x, z)) continue;
      const d = this.polylineDistance(x, z, road.points);
      if (d < road.width / 2) {
        if (h < SEA_LEVEL + 1) {
          h = SEA_LEVEL + 2;
          top = Block.PLANK;
          sub = Block.PLANK;
        } else {
          top = Block.PATH;
        }
        structure = true;
        break;
      }
    }

    // Ruins
    for (const ruin of r.ruins) {
      if (Math.abs(x - ruin.x) > ruin.radius + 10 || Math.abs(z - ruin.z) > ruin.radius + 10) continue;
      const d = dist2(x, z, ruin.x, ruin.z);
      if (d < ruin.radius + 10) {
        const base = this.ruinHeight(ruin.x, ruin.z);
        const t = smoothstep(ruin.radius, ruin.radius + 10, d);
        h = lerp(base, h, t);
        if (d < ruin.radius) {
          biome = "ruins";
          top = hash2(x, z, this.seed + 61) < 0.55 ? Block.MOSSY : Block.BRICK;
          sub = Block.BRICK;
          structure = true;
        }
      }
    }

    h = Math.round(h);

    // Buildings
    for (const b of r.buildings) {
      if (x >= b.x - b.w / 2 && x < b.x + b.w / 2 && z >= b.z - b.d / 2 && z < b.z + b.d / 2) {
        h = Math.round(town.height) + b.h;
        top = ROOF_BLOCK[b.roof];
        sub = Block.WALL;
        structure = true;
      }
    }

    const sp = this.special.get(key);
    if (sp) {
      h = sp.h;
      top = sp.top;
      sub = sp.sub;
      structure = true;
    }

    out.h = clamp(h, 1, 94);
    out.top = top;
    out.sub = sub;
    out.biome = BiomeId[biome];
    out.tree = 0;

    if (!structure) this.applyTree(x, z, out, biome);

    return out;
  }

  /** Smooth ground before water, structures and trees. */
  baseHeight(x: number, z: number): number {
    return this.groundFrom(x, z, this.mountainFactor(x, z), this.hillAmount(x, z), this.forestAmount(x, z));
  }

  private groundFrom(x: number, z: number, m: number, hill: number, forest: number): number {
    const s = this.seed;
    let ground = 19.5 + (fbm(x, z, s, 4, 1 / 140) - 0.5) * 7 + (fbm(x, z, s + 7, 2, 1 / 37) - 0.5) * 2;
    ground = Math.max(18, ground);
    if (m > 0) ground += m * (26 + fbm(x, z, s + 11, 4, 1 / 50) * 34);
    ground += hill;
    if (forest > -0.2) ground += clamp(forest + 0.2, 0, 1) * fbm(x, z, s + 13, 2, 1 / 24) * 3;
    return ground;
  }

  private inBox(b: ZoneBounds, x: number, z: number): boolean {
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  private static boxOf(points: [number, number][], pad: number): ZoneBounds {
    const xs = points.map((p) => p[0]);
    const zs = points.map((p) => p[1]);
    return { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad };
  }

  /** Signed distance to the coastline: positive on land, negative at sea. */
  shoreDistance(x: number, z: number): number {
    const c = this.region.coast;
    const coastZ = c.z + (fbm(x, 0, this.seed + 3, 3, 1 / 90) - 0.5) * 40;
    const eastX = c.eastX + (fbm(0, z, this.seed + 5, 3, 1 / 90) - 0.5) * 40;
    return Math.min(z - coastZ, eastX - x);
  }

  private mountainFactor(x: number, z: number): number {
    const m = this.region.mountains;
    return Math.max(smoothstep(m.northZ, m.northZ + 140, z), smoothstep(m.westX, m.westX - 140, x));
  }

  private hillAmount(x: number, z: number): number {
    let total = 0;
    for (const hill of this.region.hills) {
      if (Math.abs(x - hill.x) > hill.radius || Math.abs(z - hill.z) > hill.radius) continue;
      const d = dist2(x, z, hill.x, hill.z);
      if (d < hill.radius) {
        const shape = 0.5 + 0.5 * Math.cos((Math.PI * d) / hill.radius);
        total += hill.height * shape * (0.8 + 0.4 * fbm(x, z, this.seed + 17, 2, 1 / 30));
      }
    }
    return total;
  }

  private forestAmount(x: number, z: number): number {
    let best = -Infinity;
    for (const f of this.region.forests) {
      const q = 1 - ((x - f.x) / f.rx) ** 2 - ((z - f.z) / f.rz) ** 2;
      if (q > best) best = q;
    }
    return best + (fbm(x, z, this.seed + 19, 3, 1 / 45) - 0.5) * 0.5;
  }

  private polylineDistance(x: number, z: number, points: [number, number][]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const d = distToSegment(x, z, ax, az, bx, bz).d;
      if (d < best) best = d;
    }
    return best;
  }

  private readonly ruinBase = new Map<string, number>();

  private ruinHeight(x: number, z: number): number {
    const key = `${x},${z}`;
    let h = this.ruinBase.get(key);
    if (h === undefined) {
      h = Math.round(this.baseHeight(x, z));
      this.ruinBase.set(key, h);
    }
    return h;
  }

  private applyTree(x: number, z: number, out: Column, biome: BiomeName): void {
    const density = TREE_DENSITY[biome];
    if (!density) return;
    if (out.top !== Block.GRASS && out.top !== Block.FOREST_GRASS && !(biome === "island" && out.top === Block.SAND)) return;
    if (out.h < SEA_LEVEL + 1 || out.h > 46) return;

    const cx = Math.floor(x / 4);
    const cz = Math.floor(z / 4);
    const s = this.seed;
    if (x !== cx * 4 + Math.floor(hash2(cx, cz, s + 101) * 3)) return;
    if (z !== cz * 4 + Math.floor(hash2(cx, cz, s + 202) * 3)) return;
    if (hash2(cx, cz, s + 303) >= density) return;

    for (const c of this.clearings) if (dist2(x, z, c.x, c.z) < c.r) return;
    for (let i = 0; i < this.region.roads.length; i++) {
      if (!this.inBox(this.roadBoxes[i], x, z)) continue;
      if (this.polylineDistance(x, z, this.region.roads[i].points) < this.region.roads[i].width / 2 + 2) return;
    }

    const trunk = 4 + Math.floor(hash2(cx, cz, s + 404) * 3);
    out.tree = trunk;
    out.h += trunk;
    out.top = Block.LOG;
    out.sub = Block.LOG;
  }

  private buildStructures(): void {
    const r = this.region;

    this.clearings.push({ x: r.town.x, z: r.town.z, r: r.town.radius + 6 });
    for (const ruin of r.ruins) {
      this.clearings.push({ x: ruin.x, z: ruin.z, r: ruin.radius + 4 });
      const base = this.ruinHeight(ruin.x, ruin.z);

      // Ring of pillars, some broken
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = Math.round(ruin.x + Math.cos(a) * ruin.radius * 0.72);
        const pz = Math.round(ruin.z + Math.sin(a) * ruin.radius * 0.72);
        const height = 2 + Math.floor(hash2(k, ruin.x, this.seed + 71) * 5);
        for (let dx = 0; dx < 2; dx++)
          for (let dz = 0; dz < 2; dz++)
            this.special.set(`${px + dx},${pz + dz}`, { h: base + height, top: Block.BRICK, sub: Block.BRICK });
      }

      // Broken back wall
      for (let i = -4; i <= 4; i++) {
        if (hash2(i, ruin.z, this.seed + 73) < 0.25) continue;
        const height = 1 + Math.floor(hash2(i, ruin.x, this.seed + 75) * 3);
        this.special.set(`${Math.round(ruin.x + i)},${Math.round(ruin.z + ruin.radius * 0.45)}`, {
          h: base + height,
          top: Block.MOSSY,
          sub: Block.BRICK,
        });
      }
    }

    for (const it of r.interactables) {
      if ((it.zone ?? OVERWORLD) !== OVERWORLD) continue;
      const x = Math.round(it.x);
      const z = Math.round(it.z);
      const ruin = r.ruins.find((ru) => dist2(x, z, ru.x, ru.z) < ru.radius + 2);
      const base = ruin ? this.ruinHeight(ruin.x, ruin.z) : Math.round(this.baseHeight(x, z));

      if (it.kind === "altar") {
        for (let dx = -1; dx <= 1; dx++)
          for (let dz = -1; dz <= 1; dz++) this.special.set(`${x + dx},${z + dz}`, { h: base + 1, top: Block.BRICK, sub: Block.BRICK });
      } else if (it.kind === "tablet") {
        this.special.set(`${x},${z}`, { h: base + 2, top: Block.MOSSY, sub: Block.BRICK });
      }
    }

    for (const cave of r.caves) {
      const ex = Math.round(cave.entrance.x);
      const ez = Math.round(cave.entrance.z);
      this.clearings.push({ x: ex, z: ez, r: 9 });
      const base = Math.round(this.baseHeight(ex, ez));

      // Corridor opens toward the town
      const toTownX = r.town.x - ex;
      const toTownZ = r.town.z - ez;
      const alongX = Math.abs(toTownX) > Math.abs(toTownZ);
      const sign = alongX ? Math.sign(toTownX) : Math.sign(toTownZ);

      for (let a = -3; a <= 3; a++) {
        for (let b = -3; b <= 3; b++) {
          // a runs along the corridor (positive toward town), b across it
          const corridor = Math.abs(b) <= 1 && a >= -1;
          if (corridor) continue;
          const x = alongX ? ex + a * sign : ex + b;
          const z = alongX ? ez + b : ez + a * sign;
          this.special.set(`${x},${z}`, { h: base + 6 + (Math.abs(b) === 3 || a === -3 ? 0 : 1), top: Block.STONE, sub: Block.STONE });
        }
      }
      // Corridor floor is level with the entrance
      for (let a = -1; a <= 3; a++)
        for (let b = -1; b <= 1; b++) {
          const x = alongX ? ex + a * sign : ex + b;
          const z = alongX ? ez + b : ez + a * sign;
          this.special.set(`${x},${z}`, { h: base, top: Block.GRAVEL, sub: Block.STONE });
        }
    }
  }

  /** Direction (unit x/z) the cave arch opens toward. */
  caveFacing(cave: CaveDef): { x: number; z: number } {
    const dx = this.region.town.x - cave.entrance.x;
    const dz = this.region.town.z - cave.entrance.z;
    return Math.abs(dx) > Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) };
  }
}

export class CaveTerrain implements ZoneTerrain {
  readonly id: string;
  readonly waterLevel = null;
  readonly ceiling = 26;
  readonly bounds: ZoneBounds;

  constructor(private readonly cave: CaveDef) {
    this.id = caveZoneId(cave.id);
    this.bounds = { minX: 0, minZ: 0, maxX: cave.size, maxZ: cave.size };
  }

  column(x: number, z: number, out: Column = newColumn()): Column {
    const c = this.cave;
    const s = c.seed;
    out.biome = BiomeId.cave;
    out.tree = 0;

    const inside = x > 1 && z > 1 && x < c.size - 2 && z < c.size - 2;
    let open = false;

    if (inside) {
      let tunnel = Infinity;
      for (let i = 0; i + 1 < c.tunnel.length; i++) {
        const [ax, az] = c.tunnel[i];
        const [bx, bz] = c.tunnel[i + 1];
        tunnel = Math.min(tunnel, distToSegment(x, z, ax, az, bx, bz).d);
      }
      open = tunnel < 2.8 + fbm(x, z, s + 3, 2, 1 / 14) * 2.4 || fbm(x, z, s + 5, 3, 1 / 22) > 0.6;
    }

    if (!open) {
      out.h = 30;
      out.top = Block.CAVE_STONE;
      out.sub = Block.CAVE_STONE;
      return out;
    }

    out.h = Math.round(10 + fbm(x, z, s, 3, 1 / 18) * 3);
    out.top = hash2(x, z, s + 7) < 0.3 ? Block.GRAVEL : Block.CAVE_STONE;
    out.sub = Block.CAVE_STONE;

    // Crystal outcrops, kept off the guaranteed tunnel
    const cell = hash2(Math.floor(x / 3), Math.floor(z / 3), s + 9);
    if (cell < 0.035 && hash2(x, z, s + 11) < 0.5 && !this.nearTunnel(x, z, 3.2)) {
      out.h += 1 + Math.floor(hash2(x, z, s + 13) * 2);
      out.top = Block.CRYSTAL;
    }
    return out;
  }

  private nearTunnel(x: number, z: number, r: number): boolean {
    const t = this.cave.tunnel;
    for (let i = 0; i + 1 < t.length; i++) if (distToSegment(x, z, t[i][0], t[i][1], t[i + 1][0], t[i + 1][1]).d < r) return true;
    return false;
  }
}

/** All zones of one region. */
export class WorldTerrain {
  readonly overworld: OverworldTerrain;
  private readonly zones = new Map<string, ZoneTerrain>();

  constructor(readonly region: RegionDef) {
    this.overworld = new OverworldTerrain(region);
    this.zones.set(OVERWORLD, this.overworld);
    for (const cave of region.caves) this.zones.set(caveZoneId(cave.id), new CaveTerrain(cave));
  }

  zone(id: string): ZoneTerrain {
    const z = this.zones.get(id);
    if (!z) throw new Error(`unknown zone ${id}`);
    return z;
  }

  hasZone(id: string): boolean {
    return this.zones.has(id);
  }

  zoneIds(): string[] {
    return [...this.zones.keys()];
  }
}

/**
 * Chunk-granular height cache for frequent server-side queries (AI, spawning,
 * movement validation). Bounded so memory stays flat as players roam.
 */
export class TerrainCache {
  private readonly chunks = new Map<string, { h: Int16Array; biome: Uint8Array }>();

  constructor(
    private readonly terrain: ZoneTerrain,
    private readonly maxChunks = 256,
  ) {}

  private chunk(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    let c = this.chunks.get(key);
    if (c) {
      this.chunks.delete(key);
      this.chunks.set(key, c);
      return c;
    }
    c = { h: new Int16Array(CHUNK_SIZE * CHUNK_SIZE), biome: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE) };
    const col = newColumn();
    for (let lz = 0; lz < CHUNK_SIZE; lz++)
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        this.terrain.column(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz, col);
        c.h[lz * CHUNK_SIZE + lx] = col.h;
        c.biome[lz * CHUNK_SIZE + lx] = col.biome;
      }
    this.chunks.set(key, c);
    if (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value as string);
    return c;
  }

  height(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const cx = Math.floor(ix / CHUNK_SIZE);
    const cz = Math.floor(iz / CHUNK_SIZE);
    return this.chunk(cx, cz).h[(iz - cz * CHUNK_SIZE) * CHUNK_SIZE + (ix - cx * CHUNK_SIZE)];
  }

  biome(x: number, z: number): BiomeName {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const cx = Math.floor(ix / CHUNK_SIZE);
    const cz = Math.floor(iz / CHUNK_SIZE);
    return BIOMES[this.chunk(cx, cz).biome[(iz - cz * CHUNK_SIZE) * CHUNK_SIZE + (ix - cx * CHUNK_SIZE)]];
  }

  get zone(): ZoneTerrain {
    return this.terrain;
  }
}

/** Something that can answer "how high is the ground here". */
export interface HeightSource {
  height(x: number, z: number): number;
}

/** Highest column under a circular footprint (4 corner samples + centre). */
export function groundUnder(src: HeightSource, x: number, z: number, radius: number): number {
  return Math.max(
    src.height(x, z),
    src.height(x - radius, z - radius),
    src.height(x + radius, z - radius),
    src.height(x - radius, z + radius),
    src.height(x + radius, z + radius),
  );
}
