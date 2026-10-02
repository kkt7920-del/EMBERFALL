import { SEA_LEVEL, WORLD_HEIGHT } from "../config/constants";
import { Simplex } from "../math/noise";
import { hash2 } from "../math/rng";
import { clamp, lerp, smoothstep } from "../math/vec";
import type { CaveSystemDef, RegionDef } from "../types/content";
import { BiomeId, Block, type BiomeName } from "./blocks";
import { COL_BRIDGE, COL_CLEAR, COL_CLIFF, COL_RIVERBANK, COL_ROAD, COL_TOWN, COL_WATERFALL, type ColumnInfo, VoxelBox, newColumnInfo } from "./column";
import { stampStructures, stampVegetation, type StructurePlan, planStructures } from "./features";

export * from "./column";

interface Box2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Polyline {
  pts: [number, number][];
  box: Box2;
  /** Cumulative length at each point. */
  len: number[];
}

function polyline(points: [number, number][], pad: number): Polyline {
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  const len = [0];
  for (let i = 1; i < points.length; i++) len.push(len[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return {
    pts: points,
    box: { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad },
    len,
  };
}

const inBox = (b: Box2, x: number, z: number) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

/** Distance to a polyline, the segment index and the 0..1 position along that segment. */
function nearest(pl: Polyline, x: number, z: number): { d: number; seg: number; t: number } {
  let best = Infinity;
  let seg = 0;
  let bt = 0;
  const p = pl.pts;
  for (let i = 0; i + 1 < p.length; i++) {
    const ax = p[i][0];
    const az = p[i][1];
    const abx = p[i + 1][0] - ax;
    const abz = p[i + 1][1] - az;
    const l2 = abx * abx + abz * abz;
    let t = l2 === 0 ? 0 : ((x - ax) * abx + (z - az) * abz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + abx * t);
    const dz = z - (az + abz * t);
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      seg = i;
      bt = t;
    }
  }
  return { d: Math.sqrt(best), seg, t: bt };
}

interface RiverRt {
  def: RegionDef["rivers"][number];
  line: Polyline;
  /** Water surface height per metre of river length. */
  levels: Float32Array;
  /** Upstream level for the first metres below a waterfall (0 elsewhere). */
  fallUpper: Float32Array;
}

interface Segment3 {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
  min: [number, number, number];
  max: [number, number, number];
  kind: "tunnel" | "mine" | "river";
}

export interface ResolvedCave {
  def: CaveSystemDef;
  segments: Segment3[];
  path: [number, number, number][];
}

/** Region overlay + noise layers for one world. Deterministic for a given region JSON. */
export class TerrainGenerator {
  readonly region: RegionDef;
  readonly seed: number;
  readonly n: Simplex;
  readonly n2: Simplex;
  readonly n3: Simplex;
  private readonly roads: Polyline[];
  private readonly rivers: RiverRt[];
  private readonly ranges: { line: Polyline; width: number; height: number }[];
  readonly caves: ResolvedCave[];
  readonly structures: StructurePlan;
  private readonly tmp = newColumnInfo();

  constructor(region: RegionDef) {
    this.region = region;
    this.seed = region.seed;
    this.n = new Simplex(region.seed);
    this.n2 = new Simplex(region.seed + 101);
    this.n3 = new Simplex(region.seed + 202);
    this.roads = region.roads.map((r) => polyline(r.points, r.width + 4));
    this.ranges = region.mountains.map((m) => ({ line: polyline(m.points, m.width + 40), width: m.width, height: m.height }));
    this.rivers = region.rivers.map((r) => this.buildRiver(r));
    this.caves = region.caves.map((c) => this.resolveCave(c));
    this.structures = planStructures(this);
  }

  // ------------------------------------------------------------------ 2D layer

  /** Smooth land height before water, roads and structures. */
  landHeight(x: number, z: number): { h: number; mountain: number; hills: number; forest: number; volcano: number; lava: number } {
    const n = this.n;
    const r = this.region;
    const wx = x + n.noise2(x / 310, z / 310) * 46;
    const wz = z + n.noise2(x / 310 + 40, z / 310 - 70) * 46;

    // Plains: low rolling ground with small dry valleys
    let base = 67 + n.fbm2(x, z, 4, 1 / 260) * 5 + n.fbm2(x, z, 2, 1 / 55) * 1.6;
    const valley = this.n2.ridged2(wx, wz, 2, 1 / 230);
    base -= Math.max(0, valley - 0.86) * 32;

    // Hills (noise + region bumps)
    const hn = (n.fbm2(wx, wz, 3, 1 / 420) + 1) / 2;
    let hills = smoothstep(0.56, 0.86, hn) * 30 * (0.75 + 0.25 * n.noise2(x / 38, z / 38));
    for (const hill of r.hills) {
      const dx = x - hill.x;
      const dz = z - hill.z;
      if (Math.abs(dx) > hill.radius || Math.abs(dz) > hill.radius) continue;
      const d = Math.hypot(dx, dz);
      if (d < hill.radius) hills += hill.height * (0.5 + 0.5 * Math.cos((Math.PI * d) / hill.radius)) * (0.8 + 0.4 * (n.fbm2(x, z, 2, 1 / 30) * 0.5 + 0.5));
    }

    // Forest floor rolls gently
    let forest = -1;
    for (const f of r.forests) {
      const q = 1 - ((x - f.x) / f.rx) ** 2 - ((z - f.z) / f.rz) ** 2;
      if (q > forest) forest = q;
    }
    forest += n.fbm2(x, z, 3, 1 / 70) * 0.32;
    if (forest > -0.3) base += clamp(forest + 0.3, 0, 1) * (n.fbm2(x, z, 2, 1 / 46) + 0.6) * 5;

    let h = base + hills;

    // Mountain ranges: ridged noise around ridge lines
    let mountain = 0;
    let peak = 0;
    for (const m of this.ranges) {
      if (!inBox(m.line.box, wx, wz)) continue;
      const d = nearest(m.line, wx, wz).d;
      const k = smoothstep(m.width, m.width * 0.2, d);
      if (k > mountain) {
        mountain = k;
        peak = m.height;
      }
    }
    if (mountain > 0) {
      const ridge = this.n2.ridged2(wx, wz, 5, 1 / 160);
      const shape = Math.pow(mountain, 1.35);
      const mh = shape * (peak - base) * (0.5 + 0.5 * ridge) + mountain * n.fbm2(x, z, 3, 1 / 32) * 7;
      h = Math.max(h, base + mh);
    }

    // Stepped slopes and cliffs: terrace the high ground
    const terrace = clamp((mountain - 0.06) * 3 + (hills - 7) / 22, 0, 0.88);
    if (terrace > 0) {
      const step = 5 + Math.floor((n.noise2(x / 95, z / 95) + 1) * 2.5);
      const t = h / step;
      const f = t - Math.floor(t);
      const stepped = (Math.floor(t) + Math.pow(smoothstep(0.25, 0.85, f), 3)) * step;
      h = lerp(h, stepped, terrace);
    }

    // Volcano: a cone with a crater lake of lava
    let volcano = 0;
    let lava = -1;
    for (const v of r.volcanoes) {
      const d = Math.hypot(x - v.x, z - v.z);
      if (d > v.radius * 1.2) continue;
      const k = clamp(1 - d / v.radius, 0, 1);
      volcano = Math.max(volcano, smoothstep(0, 0.5, k));
      const rough = n.fbm2(x, z, 3, 1 / 18) * 4 * k;
      const cone = base + (v.height - base) * Math.pow(k, 1.5) + rough;
      if (d < v.crater) {
        const floor = v.height - v.crater * 0.75;
        h = lerp(floor, v.height - 2, Math.pow(d / v.crater, 3));
        lava = Math.round(v.height - v.crater * 0.45);
      } else h = Math.max(h, cone);
    }

    return { h, mountain, hills, forest, volcano, lava };
  }

  /** Signed distance to the coastline: positive on land, negative at sea. */
  shoreDistance(x: number, z: number): number {
    const c = this.region.coast;
    const n = this.n;
    const coastZ = c.z + n.fbm2(x, 0, 3, 1 / 160) * 34;
    const eastX = c.eastX + n.fbm2(0, z, 3, 1 / 160) * 34;
    let d = Math.min(z - coastZ, eastX - x);
    for (const isl of this.region.islands) {
      const id = Math.hypot(x - isl.x, z - isl.z) - isl.radius * (0.85 + 0.3 * (n.noise2(x / 20, z / 20) * 0.5 + 0.5));
      d = Math.max(d, -id);
    }
    return d;
  }

  /** Samples the land along a river and derives its water level (monotone downstream). */
  private buildRiver(def: RegionDef["rivers"][number]): RiverRt {
    const line = polyline(def.points, def.width + 80);
    const total = line.len[line.len.length - 1];
    const n = Math.ceil(total) + 1;
    const levels = new Float32Array(n);
    const fallUpper = new Float32Array(n);
    let cur = def.maxLevel ?? Infinity;
    let seg = 0;
    for (let s = 0; s < n; s++) {
      while (seg < line.pts.length - 2 && line.len[seg + 1] < s) seg++;
      const segLen = Math.max(1e-6, line.len[seg + 1] - line.len[seg]);
      const t = clamp((s - line.len[seg]) / segLen, 0, 1);
      const x = line.pts[seg][0] + (line.pts[seg + 1][0] - line.pts[seg][0]) * t;
      const z = line.pts[seg][1] + (line.pts[seg + 1][1] - line.pts[seg][1]) * t;
      const land = this.landHeight(x, z);
      let target = Math.floor(land.h - 2);
      // Mountain rivers fall in steps: pools joined by waterfalls
      if (land.mountain > 0.2 || land.h > 100) target = Math.floor(target / 8) * 8;
      if (this.shoreDistance(x, z) < 0) target = SEA_LEVEL;
      cur = Math.max(SEA_LEVEL, Math.min(cur, target));
      levels[s] = cur;
    }
    for (let s = 1; s < n; s++) {
      const drop = levels[s - 1] - levels[s];
      if (drop >= 3) for (let k = 0; k < 3 && s + k < n; k++) fallUpper[s + k] = levels[s - 1];
    }
    return { def, line, levels, fallUpper };
  }

  /** Water level at a point near a river, and whether it is a falling sheet. */
  private riverLevel(rv: RiverRt, seg: number, t: number): { level: number; fall: boolean; upper: number } {
    const s = rv.line.len[seg] + (rv.line.len[seg + 1] - rv.line.len[seg]) * t;
    const i = clamp(Math.round(s), 0, rv.levels.length - 1);
    const level = rv.levels[i];
    const up = rv.fallUpper[i];
    return { level, fall: up > 0, upper: up > 0 ? up : level };
  }

  /** Whether a lake's level is still unknown; computed from its rim. */
  lakeLevel(lake: RegionDef["lakes"][number]): number {
    return lake.level;
  }

  /** Full 2D decision for one column. */
  column(x: number, z: number, out: ColumnInfo = this.tmp): ColumnInfo {
    const r = this.region;
    const n = this.n;
    const land = this.landHeight(x, z);
    let h = land.h;
    let water = -1;
    let liquid: number = Block.WATER;
    let biome: BiomeName = "plains";
    let flags = 0;
    let caveAllow = 0.35;

    // Biome from shape
    if (land.volcano > 0.25) biome = "volcano";
    else if (h > r.snowline + n.noise2(x / 40, z / 40) * 8) biome = "snow_mountain";
    else if (land.mountain > 0.32 || h > 128) biome = "mountain";
    else if (land.hills > 11 || h > 92) biome = "hills";
    if (biome === "plains" || biome === "hills") {
      if (land.forest > 0.62) biome = "deep_forest";
      else if (land.forest > 0) biome = "forest";
      else if (land.forest > -0.32) biome = "forest_edge";
    }
    if (biome === "mountain" || biome === "hills" || biome === "snow_mountain") caveAllow = 1;
    if (biome === "forest" || biome === "deep_forest") caveAllow = 0.7;

    // Sea
    const shore = this.shoreDistance(x, z);
    const c = r.coast;
    if (shore < 0) {
      const d = -shore;
      let floor: number;
      // Shelf → open ocean → deep ocean → abyss, all within the region bounds
      if (d < 30) floor = lerp(SEA_LEVEL - 1, SEA_LEVEL - 8, d / 30);
      else if (d < 90) floor = lerp(SEA_LEVEL - 8, SEA_LEVEL - 17, (d - 30) / 60);
      else if (d < 180) floor = lerp(SEA_LEVEL - 17, SEA_LEVEL - 30, (d - 90) / 90);
      else if (d < 280) floor = lerp(SEA_LEVEL - 30, SEA_LEVEL - 44, (d - 180) / 100);
      else floor = lerp(SEA_LEVEL - 44, SEA_LEVEL - 54, smoothstep(280, 360, d));
      floor += n.fbm2(x, z, 3, 1 / 46) * (1.5 + Math.min(6, d / 70));
      // Seamounts and reefs
      floor += Math.max(0, this.n3.fbm2(x, z, 3, 1 / 120) - 0.35) * 30 * smoothstep(60, 200, d);
      // Undersea canyons in deep water
      const canyon = this.n3.ridged2(x, z, 2, 1 / 240);
      if (d > 160 && canyon > 0.86) floor -= (canyon - 0.86) * 160 * smoothstep(160, 260, d);
      // Shelf blends into the land near the shore
      h = d < 10 ? Math.min(lerp(Math.min(h, SEA_LEVEL), floor, d / 10), SEA_LEVEL - 1) : floor;
      water = SEA_LEVEL - 1;
      const cold = x < c.coldWestX + n.noise2(x / 80, z / 80) * 30;
      biome = d < 30 ? "coast" : d < 90 ? "shallow_sea" : d < 180 ? (cold ? "cold_ocean" : "open_ocean") : d < 280 ? (cold ? "cold_ocean" : "deep_ocean") : "abyss";
      caveAllow = d > 90 ? 0.6 : 0;
    } else if (shore < c.beachWidth) {
      const t = smoothstep(0, c.beachWidth, shore);
      h = lerp(SEA_LEVEL + 0.4, h, t * t);
      if (shore < c.beachWidth * 0.75 && h < SEA_LEVEL + 4) biome = "beach";
      caveAllow = 0;
    }
    if (shore >= 0 && water < 0) {
      // Islands: anything above the sea that is not mainland
      for (const isl of r.islands) if (Math.hypot(x - isl.x, z - isl.z) < isl.radius * 1.2) {
        h = Math.max(h, SEA_LEVEL + isl.height * smoothstep(isl.radius * 1.1, isl.radius * 0.2, Math.hypot(x - isl.x, z - isl.z)));
        if (biome === "plains" && h > SEA_LEVEL + 3) biome = "island";
      }
      h = Math.max(h, SEA_LEVEL + 0.4);
    }

    // Volcano crater lava
    if (land.lava > 0 && h < land.lava) {
      water = land.lava;
      liquid = Block.LAVA;
    }

    // Rivers carve channels and valleys
    for (const rv of this.rivers) {
      if (!inBox(rv.line.box, x, z)) continue;
      const wob = n.noise2(x / 45, z / 45) * 4;
      const near = nearest(rv.line, x + wob, z - wob);
      const half = (rv.def.width / 2) * (0.85 + 0.3 * (n.noise2(x / 30, z / 30) * 0.5 + 0.5));
      const lv = this.riverLevel(rv, near.seg, near.t);
      const level = lv.level;
      const d = near.d;
      if (d < half) {
        const q = d / half;
        const bed = Math.floor(level - 1 - rv.def.depth * (1 - q * q));
        h = Math.min(h, bed);
        if (lv.fall) {
          // Falling sheet: water stands up to the upper pool
          water = Math.max(water, Math.round(lv.upper) - 1);
          flags |= COL_WATERFALL;
        } else water = Math.max(water, Math.round(level) - 1);
        liquid = Block.WATER;
        biome = "river";
        caveAllow = 0;
        flags |= COL_CLEAR;
      } else {
        const valley = 14 + land.mountain * 40 + land.hills;
        if (d < half + valley) {
          const steep = 0.28 + land.mountain * 1.4 + (land.hills > 8 ? 0.4 : 0);
          const bank = level + 0.6 + (d - half) * steep;
          if (h > bank) h = lerp(bank, h, smoothstep(half + valley * 0.6, half + valley, d));
          if (d < half + 3) {
            h = Math.max(Math.min(h, level + 1), level + 0.4);
            flags |= COL_RIVERBANK | COL_CLEAR;
          } else if (d < half + 7) flags |= COL_RIVERBANK;
          caveAllow = Math.min(caveAllow, 0);
          if (lv.fall) flags |= COL_WATERFALL;
        }
      }
    }

    // Lakes
    for (const lake of r.lakes) {
      if (Math.abs(x - lake.x) > lake.rx * 1.6 || Math.abs(z - lake.z) > lake.rz * 1.6) continue;
      const q = Math.sqrt(((x - lake.x) / lake.rx) ** 2 + ((z - lake.z) / lake.rz) ** 2) + n.fbm2(x, z, 2, 1 / 22) * 0.12;
      if (q < 1) {
        h = Math.min(h, Math.floor(lake.level - 1 - lake.depth * (1 - q * q)));
        water = Math.max(water, lake.level - 1);
        liquid = Block.WATER;
        biome = "lake";
        caveAllow = 0;
      } else if (q < 1.45) {
        const bank = lake.level + 0.5 + (q - 1) * 16;
        if (h > bank) h = lerp(bank, h, smoothstep(1.15, 1.45, q));
        if (q < 1.12) flags |= COL_RIVERBANK | COL_CLEAR;
        caveAllow = 0;
      }
    }

    // Town plateau
    const town = r.town;
    const dTown = Math.hypot(x - town.x, z - town.z);
    if (dTown < town.radius + 30) {
      const t = smoothstep(town.radius, town.radius + 30, dTown);
      if (water < 0) h = lerp(town.height, h, t);
      if (dTown < town.radius) {
        biome = "town";
        flags |= COL_TOWN;
      }
      caveAllow = 0;
    }

    // Ruins sit on a levelled platform
    for (const ruin of r.ruins) {
      const d = Math.hypot(x - ruin.x, z - ruin.z);
      if (d > ruin.radius + 10) continue;
      if (ruin.style !== "sunken") {
        const base = (this.structures as StructurePlan | undefined)?.ruinBase.get(ruin.id) ?? h;
        h = lerp(base, h, smoothstep(ruin.radius, ruin.radius + 10, d));
        caveAllow = 0;
      }
      if (d < ruin.radius) {
        if (ruin.style !== "sunken") biome = "ruins";
        flags |= COL_CLEAR;
      }
    }

    // Roads (and bridges over water)
    for (let i = 0; i < r.roads.length; i++) {
      const road = r.roads[i];
      const pl = this.roads[i];
      if (!inBox(pl.box, x, z)) continue;
      const d = nearest(pl, x, z).d;
      if (d < road.width / 2 + 1.5) {
        flags |= COL_CLEAR;
        if (d < road.width / 2) {
          if (water >= 0) flags |= COL_BRIDGE;
          else flags |= COL_ROAD;
        }
        caveAllow = 0;
      }
    }

    // Surface materials
    let top: number = Block.GRASS;
    let filler: number = Block.DIRT;
    let fillerDepth = 3 + (hash2(x, z, this.seed + 5) < 0.5 ? 1 : 0);
    const hr = Math.round(h);
    switch (biome) {
      case "snow_mountain":
        top = Block.SNOW;
        filler = Block.STONE;
        fillerDepth = 1;
        break;
      case "mountain":
        if (hr > 138 + n.noise2(x / 25, z / 25) * 10) {
          top = n.noise2(x / 9, z / 9) > 0.35 ? Block.GRAVEL : Block.STONE;
          filler = Block.STONE;
        } else if (hr > r.snowline - 14) top = Block.SNOWY_GRASS;
        break;
      case "volcano":
        top = n.noise2(x / 12, z / 12) > 0.2 ? Block.ASH : Block.BASALT;
        filler = Block.BASALT;
        fillerDepth = 4;
        if (land.lava > 0 && Math.abs(hr - land.lava) <= 2 && liquid !== Block.LAVA) top = Block.OBSIDIAN;
        if (land.volcano > 0.75 && hash2(x, z, this.seed + 9) < 0.12) top = Block.MAGMA;
        break;
      case "deep_forest": {
        const k = n.noise2(x / 14, z / 14);
        top = k > 0.3 ? Block.PODZOL : k < -0.45 ? Block.MOSS : Block.GRASS;
        break;
      }
      case "forest":
        if (n.noise2(x / 16, z / 16) > 0.55) top = Block.PODZOL;
        break;
      case "beach":
        top = Block.SAND;
        filler = Block.SAND;
        fillerDepth = 4;
        break;
      case "river":
        top = n.noise2(x / 7, z / 7) > 0 ? Block.GRAVEL : Block.SAND;
        filler = Block.GRAVEL;
        break;
      case "lake":
        top = n.noise2(x / 9, z / 9) > 0.2 ? Block.CLAY : Block.SAND;
        filler = Block.SAND;
        break;
      case "coast":
      case "shallow_sea":
        top = n.noise2(x / 13, z / 13) > 0.5 ? Block.GRAVEL : Block.SAND;
        filler = Block.SAND;
        fillerDepth = 4;
        break;
      case "open_ocean":
      case "cold_ocean": {
        const k = n.noise2(x / 15, z / 15);
        top = k > 0.35 ? Block.GRAVEL : k < -0.4 ? Block.CLAY : Block.SAND;
        filler = Block.SAND;
        break;
      }
      case "deep_ocean":
        top = n.noise2(x / 15, z / 15) > 0 ? Block.GRAVEL : Block.SAND;
        filler = Block.GRAVEL;
        break;
      case "abyss":
        top = n.noise2(x / 11, z / 11) > 0.3 ? Block.GRAVEL : Block.DEEPSLATE;
        filler = Block.DEEPSLATE;
        break;
      case "ruins":
        top = hash2(x, z, this.seed + 61) < 0.5 ? Block.MOSSY_BRICKS : Block.ANCIENT_STONE;
        filler = Block.STONE;
        break;
      default:
        break;
    }
    if (flags & COL_RIVERBANK && water < 0) top = hash2(x, z, this.seed + 7) < 0.6 ? Block.SAND : Block.GRAVEL;
    if (flags & COL_ROAD) top = Block.PATH;
    if (biome === "island" && hr < SEA_LEVEL + 2) top = Block.SAND;

    out.h = clamp(hr, 3, WORLD_HEIGHT - 24);
    out.water = water;
    out.liquid = liquid;
    out.biome = BiomeId[biome];
    out.top = top;
    out.filler = filler;
    out.fillerDepth = fillerDepth;
    out.overhang = biome === "mountain" || biome === "snow_mountain" ? Math.round(4 + land.mountain * 9) : biome === "hills" ? 3 : 0;
    if (flags & (COL_TOWN | COL_ROAD | COL_CLEAR) || water >= 0) out.overhang = 0;
    out.caveAllow = caveAllow;
    out.mountain = land.mountain;
    out.flags = flags;
    out.forest =
      flags & (COL_CLEAR | COL_TOWN | COL_ROAD) || water >= 0
        ? 0
        : biome === "deep_forest"
          ? 0.62
          : biome === "forest"
            ? 0.42
            : biome === "forest_edge"
              ? 0.16
              : biome === "plains"
                ? 0.025
                : biome === "hills"
                  ? 0.08
                  : biome === "island"
                    ? 0.12
                    : biome === "mountain"
                      ? (hr < 140 ? 0.09 : 0)
                      : biome === "snow_mountain"
                        ? 0.03
                        : 0;
    return out;
  }

  // ------------------------------------------------------------------ caves

  private resolveCave(c: CaveSystemDef): ResolvedCave {
    const path: [number, number, number][] = c.path.map(([x, y, z]) => [x, y ?? Math.round(this.landHeight(x, z).h) + 1, z]);
    const segs: Segment3[] = [];
    const add = (pts: [number, number, number][], r: number, kind: Segment3["kind"]) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay, az] = pts[i];
        const [bx, by, bz] = pts[i + 1];
        const pad = r + 3;
        segs.push({
          ax,
          ay,
          az,
          bx,
          by,
          bz,
          r,
          min: [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.min(az, bz) - pad],
          max: [Math.max(ax, bx) + pad, Math.max(ay, by) + pad, Math.max(az, bz) + pad],
          kind,
        });
      }
    };
    add(path, c.radius, "tunnel");
    if (c.mine) add(c.mine, 2, "mine");
    if (c.river) add(c.river, 3, "river");
    return { def: c, segments: segs, path };
  }

  /** Underground sub-biome for a position below the surface, or null if it is under open sky. */
  undergroundBiome(x: number, y: number, z: number, surface: number): BiomeName | null {
    if (y > surface - 3) return null;
    for (const cave of this.caves) {
      for (const ch of cave.def.chambers) {
        const q = ((x - ch.x) / (ch.rx + 3)) ** 2 + ((y - ch.y) / (ch.ry + 3)) ** 2 + ((z - ch.z) / (ch.rz + 3)) ** 2;
        if (q < 1) return ch.kind === "crystal" ? "crystal_cave" : ch.kind === "ruin" ? "ancient_ruin" : ch.kind === "lake" ? "underground_river" : "cavern";
      }
      for (const s of cave.segments) {
        if (x < s.min[0] || y < s.min[1] || z < s.min[2] || x > s.max[0] || y > s.max[1] || z > s.max[2]) continue;
        if (segDist(s, x, y, z) < s.r + 3) {
          if (s.kind === "mine") return "mine";
          if (s.kind === "river") return "underground_river";
        }
      }
    }
    if (y < 30) return "deep_cave";
    if (this.n3.fbm3(x, y, z, 2, 1 / 70) > 0.45) return "cavern";
    return "cave";
  }

  // ------------------------------------------------------------------ 3D

  /** Generates every block of an axis-aligned box of columns (all heights). */
  generateBox(x0: number, z0: number, sx: number, sz: number): VoxelBox {
    const box = new VoxelBox(x0, z0, sx, sz);
    const cols: ColumnInfo[] = new Array((sx + 2) * (sz + 2));
    // Columns with a 1-block border for slopes
    for (let lz = -1; lz <= sz; lz++)
      for (let lx = -1; lx <= sx; lx++) {
        const c = newColumnInfo();
        this.column(x0 + lx, z0 + lz, c);
        cols[(lz + 1) * (sx + 2) + (lx + 1)] = c;
      }
    const colAt = (lx: number, lz: number) => cols[(lz + 1) * (sx + 2) + (lx + 1)];

    let maxY = 0;
    for (const c of cols) maxY = Math.max(maxY, c.h + c.overhang + 2, c.water + 1);
    maxY = Math.min(WORLD_HEIGHT - 1, maxY);

    // 3D noise on a 4-block lattice, trilinearly interpolated
    const G = 4;
    const gx0 = Math.floor(x0 / G);
    const gz0 = Math.floor(z0 / G);
    const gnx = Math.floor((x0 + sx) / G) - gx0 + 2;
    const gnz = Math.floor((z0 + sz) / G) - gz0 + 2;
    const gny = Math.floor(maxY / G) + 2;
    const lattice = (fn: (x: number, y: number, z: number) => number) => {
      const out = new Float32Array(gnx * gny * gnz);
      for (let k = 0; k < gnz; k++)
        for (let j = 0; j < gny; j++)
          for (let i = 0; i < gnx; i++) out[(k * gny + j) * gnx + i] = fn((gx0 + i) * G, j * G, (gz0 + k) * G);
      return out;
    };
    const n = this.n;
    const n2 = this.n2;
    const n3 = this.n3;
    const overhangL = lattice((x, y, z) => n.noise3(x / 22, y / 15, z / 22));
    const spagA = lattice((x, y, z) => n2.noise3(x / 46, y / 30, z / 46));
    const spagB = lattice((x, y, z) => n3.noise3(x / 46 + 31, y / 30, z / 46 - 17));
    const cheese = lattice((x, y, z) => n3.fbm3(x, y, z, 2, 1 / 70));
    const sampler = (L: Float32Array) => (wx: number, y: number, wz: number) => {
      const fx = wx / G - gx0;
      const fy = y / G;
      const fz = wz / G - gz0;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const k = Math.floor(fz);
      const tx = fx - i;
      const ty = fy - j;
      const tz = fz - k;
      const o = (k * gny + j) * gnx + i;
      const a = L[o] + (L[o + 1] - L[o]) * tx;
      const b = L[o + gnx] + (L[o + gnx + 1] - L[o + gnx]) * tx;
      const o2 = o + gnx * gny;
      const c = L[o2] + (L[o2 + 1] - L[o2]) * tx;
      const d = L[o2 + gnx] + (L[o2 + gnx + 1] - L[o2 + gnx]) * tx;
      const ab = a + (b - a) * ty;
      const cd = c + (d - c) * ty;
      return ab + (cd - ab) * tz;
    };
    const ovh = sampler(overhangL);
    const sA = sampler(spagA);
    const sB = sampler(spagB);
    const ch = sampler(cheese);
    const seed = this.seed;

    const blocks = box.blocks;
    const layer = sx * sz;
    for (let lz = 0; lz < sz; lz++)
      for (let lx = 0; lx < sx; lx++) {
        const c = colAt(lx, lz);
        const wx = x0 + lx;
        const wz = z0 + lz;
        // Slope: steep columns in rocky biomes show bare stone (cliff faces)
        const slope = Math.max(
          Math.abs(c.h - colAt(lx - 1, lz).h),
          Math.abs(c.h - colAt(lx + 1, lz).h),
          Math.abs(c.h - colAt(lx, lz - 1).h),
          Math.abs(c.h - colAt(lx, lz + 1).h),
        );
        let top = c.top;
        let filler = c.filler;
        const rocky = c.biome === BiomeId.mountain || c.biome === BiomeId.hills || c.biome === BiomeId.snow_mountain || c.mountain > 0.2;
        if (rocky && slope >= 3 && c.water < 0) {
          top = c.biome === BiomeId.snow_mountain ? (slope >= 5 ? Block.PACKED_ICE : Block.STONE) : Block.STONE;
          filler = Block.STONE;
          c.flags |= COL_CLIFF;
        }
        if (c.biome === BiomeId.snow_mountain && slope <= 1 && n.noise2(wx / 30, wz / 30) > 0.45) top = Block.ICE; // glacier
        box.biomes[lz * sx + lx] = c.biome;
        box.surface[lz * sx + lx] = c.h;
        box.waterTop[lz * sx + lx] = c.water;

        const amp = c.overhang;
        const ocean = c.water >= 0 && c.liquid === Block.WATER && c.biome >= BiomeId.coast && c.biome <= BiomeId.cold_ocean;
        const yTop = Math.max(c.h + amp, c.water);
        const deepY = 20 + Math.floor(hash2(wx, wz, seed + 13) * 6);
        let depth = 0;
        for (let y = yTop; y >= 0; y--) {
          let solid = y <= c.h;
          if (amp > 0 && y >= c.h - amp && y <= c.h + amp) solid = c.h - y + amp * ovh(wx, y, wz) * 1.4 > 0;
          let carved = false;
          if (solid && y > 3) {
            const cover = c.h - y;
            const minCover = c.caveAllow >= 1 ? -2 : c.caveAllow > 0.5 ? 4 : c.caveAllow > 0 ? 9 : 16;
            if (cover >= minCover) {
              const a = sA(wx, y, wz);
              const b = sB(wx, y, wz);
              const thick = 0.0085 + (y < 40 ? 0.006 : 0) + (c.caveAllow > 0.5 ? 0.003 : 0);
              if (a * a + b * b < thick) carved = true;
              else if (y > 8 && cover > 14 && ch(wx, y, wz) > 0.56) carved = true;
            }
          }
          let block: number;
          if (solid && !carved) {
            if (y === 0 || (y <= 2 && hash2(wx * 31 + y, wz, seed + 3) < 0.5)) block = Block.BEDROCK;
            else if (depth === 0) block = top;
            else if (depth < c.fillerDepth) block = filler === Block.SAND && depth >= 3 ? Block.SANDSTONE : filler;
            else block = y < deepY ? Block.DEEPSLATE : Block.STONE;
            // Snow-covered ground keeps dirt under the top layer
            if (depth > 0 && depth < c.fillerDepth && top === Block.GRASS) block = Block.DIRT;
            depth++;
          } else {
            if (carved) {
              block = ocean ? Block.WATER : y < 11 ? Block.LAVA : Block.AIR;
            } else {
              block = y <= c.water ? c.liquid : Block.AIR;
              // An overhang's underside starts a new surface run below it
              if (y < c.h) depth = 0;
            }
          }
          if (block !== Block.AIR) blocks[y * layer + lz * sx + lx] = block;
        }
      }
    box.maxY = maxY;

    this.carveCaveSystems(box);
    this.placeOres(box);
    stampVegetation(this, box, colAt);
    stampStructures(this, box);
    box.recomputeTop();
    return box;
  }

  private carveCaveSystems(box: VoxelBox): void {
    const x1 = box.x0 + box.sx - 1;
    const z1 = box.z0 + box.sz - 1;
    for (const cave of this.caves) {
      for (const s of cave.segments) {
        if (s.max[0] < box.x0 || s.min[0] > x1 || s.max[2] < box.z0 || s.min[2] > z1) continue;
        const xa = Math.max(box.x0, Math.floor(s.min[0]));
        const xb = Math.min(x1, Math.ceil(s.max[0]));
        const za = Math.max(box.z0, Math.floor(s.min[2]));
        const zb = Math.min(z1, Math.ceil(s.max[2]));
        const ya = Math.max(1, Math.floor(s.min[1]));
        const yb = Math.min(WORLD_HEIGHT - 2, Math.ceil(s.max[1]));
        for (let z = za; z <= zb; z++)
          for (let x = xa; x <= xb; x++)
            for (let y = ya; y <= yb; y++) {
              const d = segDist(s, x + 0.5, y + 0.5, z + 0.5);
              if (s.kind === "mine") {
                // Square timbered tunnel: 3 wide, 3 tall
                const t = segT(s, x + 0.5, y + 0.5, z + 0.5);
                const cx = s.ax + (s.bx - s.ax) * t;
                const cy = s.ay + (s.by - s.ay) * t;
                const cz = s.az + (s.bz - s.az) * t;
                const along = Math.abs(s.bx - s.ax) > Math.abs(s.bz - s.az) ? "x" : "z";
                const across = along === "x" ? Math.abs(z + 0.5 - cz) : Math.abs(x + 0.5 - cx);
                const up = y + 0.5 - cy;
                if (d > 4) continue;
                if (across <= 1.5 && up >= -0.5 && up <= 2.6) {
                  const pos = along === "x" ? x : z;
                  const post = ((pos % 6) + 6) % 6 === 0;
                  if (post && across > 0.9 && up < 2.1) box.set(x, y, z, Block.OAK_LOG);
                  else if (post && up > 2.1) box.set(x, y, z, Block.PLANKS);
                  else if (up < 0.5 && across <= 1.5) box.set(x, y, z, Block.DARK_PLANKS);
                  else if (post && up > 1.6 && across < 0.6 && ((pos / 6) | 0) % 2 === 0) box.set(x, y, z, Block.LAMP);
                  else box.set(x, y, z, Block.AIR);
                }
                continue;
              }
              const wob = this.n.noise3(x / 9, y / 9, z / 9) * 1.3;
              if (d < s.r + wob) {
                if (s.kind === "river" && y + 0.5 < s.ay + (s.by - s.ay) * segT(s, x + 0.5, y + 0.5, z + 0.5) - s.r * 0.35) box.set(x, y, z, Block.WATER);
                else box.set(x, y, z, Block.AIR);
              }
            }
      }
      for (const chb of cave.def.chambers) {
        const xa = Math.max(box.x0, chb.x - chb.rx - 2);
        const xb = Math.min(x1, chb.x + chb.rx + 2);
        const za = Math.max(box.z0, chb.z - chb.rz - 2);
        const zb = Math.min(z1, chb.z + chb.rz + 2);
        if (xa > xb || za > zb) continue;
        for (let z = za; z <= zb; z++)
          for (let x = xa; x <= xb; x++)
            for (let y = Math.max(1, chb.y - chb.ry - 2); y <= chb.y + chb.ry + 2; y++) {
              const q = ((x + 0.5 - chb.x) / chb.rx) ** 2 + ((y + 0.5 - chb.y) / chb.ry) ** 2 + ((z + 0.5 - chb.z) / chb.rz) ** 2;
              const wob = this.n.noise3(x / 7, y / 7, z / 7) * 0.18;
              if (q < 1 + wob) {
                // Flat-ish floor in the lower part
                const floorY = chb.y - chb.ry * 0.55;
                if (y < floorY) {
                  if (chb.kind === "lake" && y >= floorY - 3) box.set(x, y, z, Block.WATER);
                  else if (chb.kind === "ruin" && y >= floorY - 1) box.set(x, y, z, hash2(x, z, this.seed + 91) < 0.3 ? Block.MOSSY_BRICKS : Block.ANCIENT_STONE);
                  continue;
                }
                box.set(x, y, z, Block.AIR);
              } else if (q < 1.35 + wob) {
                const cur = box.get(x, y, z);
                if (cur === Block.AIR || cur === Block.WATER) continue;
                if (chb.kind === "crystal" && hash2(x * 7 + y, z, this.seed + 93) < 0.16) box.set(x, y, z, Block.CRYSTAL);
                if (chb.kind === "ruin") box.set(x, y, z, hash2(x + y * 3, z, this.seed + 95) < 0.12 ? Block.ANCIENT_CARVED : Block.ANCIENT_STONE);
              }
            }
        if (chb.kind === "ruin") {
          // Pillars around the hall
          for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2;
            const px = Math.round(chb.x + Math.cos(a) * chb.rx * 0.65);
            const pz = Math.round(chb.z + Math.sin(a) * chb.rz * 0.65);
            const floorY = Math.ceil(chb.y - chb.ry * 0.55);
            const tall = 3 + Math.floor(hash2(k, chb.x, this.seed + 97) * Math.max(1, chb.ry));
            for (let y = floorY; y < floorY + tall; y++) box.set(px, y, pz, k % 3 === 0 ? Block.ANCIENT_CARVED : Block.ANCIENT_STONE);
          }
        }
      }
    }
  }

  private placeOres(box: VoxelBox): void {
    const cell = 32;
    const ca = Math.floor((box.x0 - 3) / cell);
    const cb = Math.floor((box.x0 + box.sx + 3) / cell);
    const da = Math.floor((box.z0 - 3) / cell);
    const db = Math.floor((box.z0 + box.sz + 3) / cell);
    const kinds: [number, number, number, number, number][] = [
      // block, veins per cell, size, minY, maxY
      [Block.COAL_ORE, 16, 9, 30, 150],
      [Block.COPPER_ORE, 9, 8, 35, 100],
      [Block.IRON_ORE, 9, 6, 8, 80],
      [Block.GOLD_ORE, 4, 5, 4, 36],
      [Block.CRYSTAL, 2, 3, 6, 34],
    ];
    for (let cz = da; cz <= db; cz++)
      for (let cx = ca; cx <= cb; cx++) {
        let s = Math.floor(hash2(cx, cz, this.seed + 404) * 4294967296) >>> 0;
        const rnd = () => {
          s = (s + 0x6d2b79f5) >>> 0;
          let t = s;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        for (const [block, count, size, minY, maxY] of kinds) {
          for (let v = 0; v < count; v++) {
            let x = cx * cell + Math.floor(rnd() * cell);
            let y = minY + Math.floor(rnd() * (maxY - minY));
            let z = cz * cell + Math.floor(rnd() * cell);
            for (let k = 0; k < size; k++) {
              const cur = box.get(x, y, z);
              if (cur === Block.STONE) box.set(x, y, z, block);
              else if (cur === Block.DEEPSLATE) box.set(x, y, z, block === Block.GOLD_ORE ? Block.DEEPSLATE_GOLD : block);
              const r = rnd();
              if (r < 0.33) x += rnd() < 0.5 ? 1 : -1;
              else if (r < 0.66) y += rnd() < 0.5 ? 1 : -1;
              else z += rnd() < 0.5 ? 1 : -1;
            }
          }
        }
      }
  }

  /** Cheap far-distance column for LOD meshes: height and top block only (no caves). */
  lodColumn(x: number, z: number, out: ColumnInfo): { h: number; top: number; canopy: number } {
    this.column(x, z, out);
    let canopy = 0;
    if (out.forest > 0.1 && out.water < 0) {
      // Approximate tree cover as a raised leafy layer
      const k = this.n.noise2(x / 9, z / 9) * 0.5 + 0.5;
      if (k < out.forest * 1.5) canopy = 5 + Math.floor(k * 6);
    }
    return { h: out.h, top: out.top, canopy };
  }
}

export function segT(s: Segment3, x: number, y: number, z: number): number {
  const abx = s.bx - s.ax;
  const aby = s.by - s.ay;
  const abz = s.bz - s.az;
  const l2 = abx * abx + aby * aby + abz * abz;
  if (l2 === 0) return 0;
  return clamp(((x - s.ax) * abx + (y - s.ay) * aby + (z - s.az) * abz) / l2, 0, 1);
}

export function segDist(s: Segment3, x: number, y: number, z: number): number {
  const t = segT(s, x, y, z);
  const dx = x - (s.ax + (s.bx - s.ax) * t);
  const dy = y - (s.ay + (s.by - s.ay) * t);
  const dz = z - (s.az + (s.bz - s.az) * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

