import { hash2 } from "../math/rng";
import type { BuildingDef, InteractableDef, RuinDef, ShipwreckDef } from "../types/content";
import { BiomeId, Block } from "./blocks";
import { COL_CLEAR, COL_CLIFF, COL_ROAD, COL_TOWN, type ColumnInfo, type VoxelBox, newColumnInfo } from "./column";
import type { TerrainGenerator } from "./generator";

/** A placed structure: bounding box plus a stamp that writes its blocks into any overlapping box. */
interface Placed {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  stamp(box: VoxelBox): void;
}

export interface StructurePlan {
  ruinBase: Map<string, number>;
  items: Placed[];
}

const ROOF = { red: Block.ROOF_RED, blue: Block.ROOF_BLUE, green: Block.ROOF_GREEN, orange: Block.ROOF_ORANGE } as const;

/** Decides where every hand-placed structure goes (once per world). */
export function planStructures(gen: TerrainGenerator): StructurePlan {
  const r = gen.region;
  const plan: StructurePlan = { ruinBase: new Map(), items: [] };
  const col = newColumnInfo();

  for (const ruin of r.ruins) {
    if (ruin.style === "sunken") {
      gen.column(ruin.x, ruin.z, col);
      plan.ruinBase.set(ruin.id, col.h);
    } else plan.ruinBase.set(ruin.id, Math.round(gen.landHeight(ruin.x, ruin.z).h));
  }

  const base = Math.round(r.town.height);
  for (const b of r.buildings) plan.items.push(building(b, base));
  for (const ruin of r.ruins) plan.items.push(ruinStructure(gen, ruin, plan.ruinBase.get(ruin.id)!));
  for (const w of r.shipwrecks) {
    gen.column(w.x, w.z, col);
    plan.items.push(shipwreck(gen, w, col.h));
  }
  for (const it of r.interactables) {
    const p = interactable(gen, it, plan);
    if (p) plan.items.push(p);
  }

  // Town lamp posts along the roads, and a fountain on the plaza
  const town = r.town;
  for (const road of r.roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const nx = -(bz - az) / len;
      const nz = (bx - ax) / len;
      for (let s = 6; s < len; s += 14) {
        const x = Math.round(ax + ((bx - ax) * s) / len + nx * (road.width / 2 + 1.5));
        const z = Math.round(az + ((bz - az) * s) / len + nz * (road.width / 2 + 1.5));
        if (Math.hypot(x - town.x, z - town.z) > town.radius + 40) continue;
        if (r.buildings.some((bd) => Math.abs(x - bd.x) < bd.w / 2 + 2 && Math.abs(z - bd.z) < bd.d / 2 + 2)) continue;
        gen.column(x, z, col);
        if (col.water >= 0) continue;
        const g = col.h;
        plan.items.push({
          minX: x,
          maxX: x,
          minZ: z,
          maxZ: z,
          stamp(box) {
            for (let y = g + 1; y <= g + 3; y++) box.set(x, y, z, Block.OAK_LOG);
            box.set(x, g + 4, z, Block.LAMP);
          },
        });
      }
    }
  }
  const fx = town.x + 12;
  const fz = town.z - 12;
  plan.items.push({
    minX: fx - 3,
    maxX: fx + 3,
    minZ: fz - 3,
    maxZ: fz + 3,
    stamp(box) {
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.hypot(dx, dz);
          if (d > 3.3) continue;
          box.set(fx + dx, base, fz + dz, Block.STONE_BRICKS);
          if (d > 2.4) box.set(fx + dx, base + 1, fz + dz, Block.STONE_BRICKS);
          else box.set(fx + dx, base + 1, fz + dz, Block.WATER);
        }
      for (let y = base + 1; y <= base + 3; y++) box.set(fx, y, fz, Block.STONE_BRICKS);
      box.set(fx, base + 4, fz, Block.WATER);
    },
  });

  // Bridges where roads cross water
  for (const road of r.roads) {
    const cells = new Map<string, [number, number]>();
    let deck = -1;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i];
      const [bx, bz] = road.points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= len; s += 0.5) {
        const cx = ax + ((bx - ax) * s) / len;
        const cz = az + ((bz - az) * s) / len;
        for (let o = -road.width / 2; o <= road.width / 2; o += 0.5) {
          const x = Math.round(cx + (-(bz - az) / len) * o);
          const z = Math.round(cz + ((bx - ax) / len) * o);
          gen.column(x, z, col);
          if (col.water >= 0 && col.liquid === Block.WATER) {
            cells.set(`${x},${z}`, [x, z]);
            deck = Math.max(deck, col.water + 2);
          }
        }
      }
    }
    if (cells.size === 0) continue;
    const list = [...cells.values()];
    const xs = list.map((c) => c[0]);
    const zs = list.map((c) => c[1]);
    const y = deck;
    plan.items.push({
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
      stamp(box) {
        for (const [x, z] of list) {
          box.set(x, y, z, Block.PLANKS);
          box.set(x, y + 1, z, Block.AIR);
          box.set(x, y + 2, z, Block.AIR);
          if ((x + z) % 5 === 0) for (let k = y - 1; k > y - 8; k--) {
            const cur = box.get(x, k, z);
            if (cur !== Block.WATER && cur !== Block.AIR) break;
            box.set(x, k, z, Block.OAK_LOG);
          }
        }
      },
    });
  }
  return plan;
}

function building(b: BuildingDef, base: number): Placed {
  const x0 = Math.round(b.x - b.w / 2);
  const z0 = Math.round(b.z - b.d / 2);
  const x1 = x0 + b.w - 1;
  const z1 = z0 + b.d - 1;
  const roof = ROOF[b.roof];
  const alongX = b.w >= b.d;
  const halfAcross = Math.floor((alongX ? b.d : b.w) / 2);
  return {
    minX: x0 - 1,
    maxX: x1 + 1,
    minZ: z0 - 1,
    maxZ: z1 + 1,
    stamp(box) {
      const top = base + b.h;
      for (let z = z0 - 1; z <= z1 + 1; z++)
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const edge = x < x0 || x > x1 || z < z0 || z > z1;
          // Foundation down to the ground, air above inside
          for (let y = base - 5; y <= base; y++) if (!edge || y < base) box.set(x, y, z, edge ? Block.COBBLE : y === base ? Block.PLANKS : Block.COBBLE);
          if (edge) {
            box.set(x, base, z, Block.COBBLE);
            continue;
          }
          const wall = x === x0 || x === x1 || z === z0 || z === z1;
          const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
          for (let y = base + 1; y <= top + halfAcross + 2; y++) box.set(x, y, z, Block.AIR);
          if (!wall) continue;
          for (let y = base + 1; y <= top; y++) {
            let block: number = corner ? Block.OAK_LOG : y === base + 1 ? Block.STONE_BRICKS : y === top ? Block.PLANKS : Block.PLASTER;
            const pos = x === x0 || x === x1 ? z - z0 : x - x0;
            if (!corner && (y === base + 2 || y === base + 3) && pos % 3 === 1) block = Block.GLASS;
            box.set(x, y, z, block);
          }
        }
      // Door opening (2 wide, 2 tall) and lamp above it
      const midX = Math.floor((x0 + x1) / 2);
      const midZ = Math.floor((z0 + z1) / 2);
      const door: [number, number][] =
        b.door === "s" ? [[midX, z0], [midX + 1, z0]] : b.door === "n" ? [[midX, z1], [midX + 1, z1]] : b.door === "e" ? [[x1, midZ], [x1, midZ + 1]] : [[x0, midZ], [x0, midZ + 1]];
      for (const [x, z] of door) {
        box.set(x, base + 1, z, Block.AIR);
        box.set(x, base + 2, z, Block.AIR);
        box.set(x, base + 3, z, Block.DARK_PLANKS);
      }
      const out = b.door === "s" ? [0, -1] : b.door === "n" ? [0, 1] : b.door === "e" ? [1, 0] : [-1, 0];
      box.set(door[0][0] + out[0] * 0, base + 4, door[0][1] + out[1] * 0, Block.LAMP);
      // Flat ceiling + stepped gable roof with 1-block eaves
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) box.set(x, top, z, Block.PLANKS);
      for (let k = 0; k <= halfAcross + 1; k++) {
        const y = top + 1 + k;
        const span = halfAcross + 1 - k;
        if (span < 0) break;
        if (alongX) {
          for (let x = x0 - 1; x <= x1 + 1; x++)
            for (const z of [midZ - span + (b.d % 2 === 0 ? 1 : 0), midZ + span]) box.set(x, y, z, roof);
          for (let z = midZ - span + 1 + (b.d % 2 === 0 ? 1 : 0); z < midZ + span; z++) {
            box.set(x0, y, z, Block.PLASTER);
            box.set(x1, y, z, Block.PLASTER);
            if (span <= 1) for (let x = x0 - 1; x <= x1 + 1; x++) box.set(x, y, z, roof);
          }
        } else {
          for (let z = z0 - 1; z <= z1 + 1; z++)
            for (const x of [midX - span + (b.w % 2 === 0 ? 1 : 0), midX + span]) box.set(x, y, z, roof);
          for (let x = midX - span + 1 + (b.w % 2 === 0 ? 1 : 0); x < midX + span; x++) {
            box.set(x, y, z0, Block.PLASTER);
            box.set(x, y, z1, Block.PLASTER);
            if (span <= 1) for (let z = z0 - 1; z <= z1 + 1; z++) box.set(x, y, z, roof);
          }
        }
      }
      // Interior
      box.set(midX, top - 1, midZ, Block.LAMP);
      if (b.kind === "center" || b.kind === "shop") {
        const cz = b.door === "s" ? z0 + 3 : b.door === "n" ? z1 - 3 : midZ;
        for (let x = x0 + 2; x <= x1 - 2; x++) if (b.door === "s" || b.door === "n") box.set(x, base + 1, cz, Block.PLANKS);
      }
      if (b.kind === "lab") {
        const back = b.door === "s" ? z1 - 1 : z0 + 1;
        for (let x = x0 + 1; x <= x1 - 1; x++) for (let y = base + 1; y <= base + 2; y++) box.set(x, y, back, Block.BOOKSHELF);
      }
    },
  };
}

function ruinStructure(gen: TerrainGenerator, ruin: RuinDef, base: number): Placed {
  const R = ruin.radius;
  const seed = gen.seed;
  const sunken = ruin.style === "sunken";
  return {
    minX: Math.floor(ruin.x - R - 3),
    maxX: Math.ceil(ruin.x + R + 3),
    minZ: Math.floor(ruin.z - R - 3),
    maxZ: Math.ceil(ruin.z + R + 3),
    stamp(box) {
      const fill = sunken ? Block.WATER : Block.AIR;
      // Platform and broken floor
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(dx, dz);
          if (d > R) continue;
          const x = Math.round(ruin.x + dx);
          const z = Math.round(ruin.z + dz);
          if (hash2(x, z, seed + 71) < (sunken ? 0.35 : 0.12)) continue;
          box.set(x, base, z, hash2(x, z, seed + 72) < 0.4 ? Block.MOSSY_BRICKS : Block.ANCIENT_STONE);
          for (let y = base + 1; y <= base + 9; y++) {
            const cur = box.get(x, y, z);
            if (cur !== Block.AIR && cur !== Block.WATER && !(cur >= Block.OAK_LOG && cur <= Block.JUNGLE_LEAVES)) box.set(x, y, z, fill);
          }
          if (d > R - 1.2) box.set(x, base + 1, z, Block.STONE_BRICKS);
        }
      // Ring of pillars, some broken
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + 0.2;
        const px = Math.round(ruin.x + Math.cos(a) * R * 0.72);
        const pz = Math.round(ruin.z + Math.sin(a) * R * 0.72);
        const tall = 2 + Math.floor(hash2(k, ruin.x, seed + 73) * 7);
        for (let dx = 0; dx < 2; dx++)
          for (let dz = 0; dz < 2; dz++)
            for (let y = base + 1; y <= base + tall; y++) box.set(px + dx, y, pz + dz, y === base + tall && tall > 5 ? Block.ANCIENT_CARVED : Block.ANCIENT_STONE);
        if (tall < 4) {
          // Fallen drum lying next to the stump
          const fx = px + Math.round(Math.cos(a) * 3);
          const fz = pz + Math.round(Math.sin(a) * 3);
          for (let i = 0; i < 3; i++) box.set(fx + (k % 2 ? i : 0), base + 1, fz + (k % 2 ? 0 : i), Block.ANCIENT_STONE);
        }
      }
      // Back wall with a window arch
      const wz = Math.round(ruin.z + R * 0.5);
      for (let i = -5; i <= 5; i++) {
        if (hash2(i, ruin.z, seed + 74) < 0.2) continue;
        const height = 3 + Math.floor(hash2(i, ruin.x, seed + 75) * 3);
        for (let y = base + 1; y <= base + height; y++) {
          if (Math.abs(i) <= 1 && y >= base + 2 && y <= base + 3) continue;
          box.set(Math.round(ruin.x + i), y, wz, hash2(i, y, seed + 76) < 0.3 ? Block.MOSSY_BRICKS : Block.STONE_BRICKS);
        }
      }
    },
  };
}

function shipwreck(gen: TerrainGenerator, w: ShipwreckDef, floor: number): Placed {
  const L = 11;
  const seed = gen.seed;
  const base = floor - 1;
  const at = (a: number, b: number): [number, number] => (w.axis === 0 ? [w.x + a, w.z + b] : [w.x + b, w.z + a]);
  return {
    minX: w.x - 12,
    maxX: w.x + 12,
    minZ: w.z - 12,
    maxZ: w.z + 12,
    stamp(box) {
      for (let a = -L; a <= L; a++) {
        const k = Math.abs(a) / (L + 0.5);
        const half = Math.max(0.6, 3.4 * Math.sqrt(Math.max(0, 1 - Math.pow(k, 3))));
        const hb = Math.round(half);
        for (let b = -hb; b <= hb; b++) {
          const [x, z] = at(a, b);
          const side = Math.abs(b) === hb;
          for (let y = base; y <= base + 5; y++) {
            const row = y - base;
            const narrow = row === 0 ? Math.abs(b) <= Math.max(0, hb - 2) : row === 1 ? Math.abs(b) <= hb - 1 : true;
            if (!narrow) continue;
            if (hash2(x + y * 3, z, seed + 81) < 0.12) continue; // rotten holes
            if (row === 0 || (side && row <= 4)) box.set(x, y, z, row === 0 ? Block.DARK_PLANKS : Block.PLANKS);
            else if (row === 4 && hash2(x, z, seed + 82) < 0.7) box.set(x, y, z, Block.DARK_PLANKS);
            else if (row < 4) box.set(x, y, z, row === 1 && hash2(x, z, seed + 83) < 0.5 ? Block.SAND : Block.WATER);
          }
        }
      }
      // Masts (one snapped)
      for (const [a, h] of [[-3, 9], [5, 4]] as const) {
        const [x, z] = at(a, 0);
        for (let y = base + 1; y <= base + 4 + h; y++) box.set(x, y, z, Block.OAK_LOG);
      }
    },
  };
}

function interactable(gen: TerrainGenerator, it: InteractableDef, plan: StructurePlan): Placed | null {
  const x = Math.round(it.x);
  const z = Math.round(it.z);
  const ruin = gen.region.ruins.find((r) => Math.hypot(x - r.x, z - r.z) < r.radius + 2);
  const col = newColumnInfo();
  const ground = it.y ?? (ruin ? plan.ruinBase.get(ruin.id)! : gen.column(x, z, col).h);
  switch (it.kind) {
    case "altar":
      return {
        minX: x - 1,
        maxX: x + 1,
        minZ: z - 1,
        maxZ: z + 1,
        stamp(box) {
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) box.set(x + dx, ground + 1, z + dz, Block.STONE_BRICKS);
          box.set(x, ground + 1, z, Block.ANCIENT_CARVED);
        },
      };
    case "tablet":
      return {
        minX: x,
        maxX: x,
        minZ: z,
        maxZ: z,
        stamp(box) {
          box.set(x, ground + 1, z, Block.ANCIENT_STONE);
          box.set(x, ground + 2, z, Block.ANCIENT_CARVED);
        },
      };
    case "sign":
      return {
        minX: x,
        maxX: x,
        minZ: z,
        maxZ: z,
        stamp(box) {
          box.set(x, ground + 1, z, Block.OAK_LOG);
          box.set(x, ground + 2, z, Block.PLANKS);
        },
      };
    case "crystal":
      return {
        minX: x - 1,
        maxX: x + 1,
        minZ: z - 1,
        maxZ: z + 1,
        stamp(box) {
          box.set(x, ground + 1, z, Block.CRYSTAL);
          box.set(x, ground + 2, z, Block.CRYSTAL);
          box.set(x + 1, ground + 1, z, Block.CRYSTAL);
          box.set(x, ground + 1, z - 1, Block.CRYSTAL);
        },
      };
  }
  return null;
}

/** Writes structures overlapping the box. */
export function stampStructures(gen: TerrainGenerator, box: VoxelBox): void {
  const x1 = box.x0 + box.sx - 1;
  const z1 = box.z0 + box.sz - 1;
  for (const s of gen.structures.items) {
    if (s.maxX < box.x0 || s.minX > x1 || s.maxZ < box.z0 || s.minZ > z1) continue;
    s.stamp(box);
  }
}

// ------------------------------------------------------------------ vegetation

const CELL = 5;
const MARGIN = 7;

type TreeKind = "oak_small" | "oak" | "oak_large" | "birch" | "pine" | "giant" | "bush" | "log" | "boulder" | "mushroom" | "pond" | "dead";

function pickKind(biome: number, r: number, mountainous: boolean): TreeKind {
  const B = BiomeId;
  switch (biome) {
    case B.plains:
      return r < 0.45 ? "bush" : r < 0.8 ? "oak_small" : r < 0.94 ? "oak" : r < 0.97 ? "boulder" : "oak_large";
    case B.forest_edge:
      return r < 0.3 ? "bush" : r < 0.55 ? "oak_small" : r < 0.75 ? "oak" : r < 0.9 ? "birch" : r < 0.95 ? "log" : "boulder";
    case B.forest:
      return r < 0.12 ? "bush" : r < 0.42 ? "oak" : r < 0.6 ? "birch" : r < 0.74 ? "oak_large" : r < 0.82 ? "pine" : r < 0.88 ? "log" : r < 0.93 ? "boulder" : r < 0.97 ? "mushroom" : "pond";
    case B.deep_forest:
      return r < 0.1 ? "bush" : r < 0.32 ? "oak_large" : r < 0.5 ? "giant" : r < 0.66 ? "oak" : r < 0.76 ? "pine" : r < 0.84 ? "log" : r < 0.9 ? "mushroom" : r < 0.96 ? "boulder" : "pond";
    case B.hills:
      return r < 0.3 ? "bush" : r < 0.6 ? "oak" : r < 0.8 ? "birch" : r < 0.9 ? "pine" : "boulder";
    case B.mountain:
      return mountainous && r < 0.75 ? "pine" : r < 0.85 ? "boulder" : "bush";
    case B.snow_mountain:
      return r < 0.85 ? "pine" : "boulder";
    case B.island:
      return r < 0.4 ? "bush" : "oak_small";
    case B.volcano:
      return r < 0.6 ? "dead" : "boulder";
    default:
      return "bush";
  }
}

export function stampVegetation(gen: TerrainGenerator, box: VoxelBox, colAt: (lx: number, lz: number) => ColumnInfo): void {
  const seed = gen.seed;
  const ca = Math.floor((box.x0 - MARGIN) / CELL);
  const cb = Math.floor((box.x0 + box.sx + MARGIN) / CELL);
  const da = Math.floor((box.z0 - MARGIN) / CELL);
  const db = Math.floor((box.z0 + box.sz + MARGIN) / CELL);
  const outside = newColumnInfo();
  for (let cz = da; cz <= db; cz++)
    for (let cx = ca; cx <= cb; cx++) {
      const x = cx * CELL + Math.floor(hash2(cx, cz, seed + 101) * (CELL - 1));
      const z = cz * CELL + Math.floor(hash2(cx, cz, seed + 102) * (CELL - 1));
      const lx = x - box.x0;
      const lz = z - box.z0;
      let c: ColumnInfo;
      if (lx >= 0 && lz >= 0 && lx < box.sx && lz < box.sz) c = colAt(lx, lz);
      else c = gen.column(x, z, outside);
      const roll = hash2(cx, cz, seed + 103);
      const density = c.forest;
      if (roll >= density || c.water >= 0) continue;
      if (c.flags & (COL_CLEAR | COL_TOWN | COL_ROAD | COL_CLIFF)) continue;
      const okGround =
        c.top === Block.GRASS || c.top === Block.PODZOL || c.top === Block.MOSS || c.top === Block.SNOW || c.top === Block.SNOWY_GRASS || c.top === Block.ASH || (c.biome === BiomeId.island && c.top === Block.SAND);
      if (!okGround) continue;
      const kind = pickKind(c.biome, hash2(cx, cz, seed + 104), c.mountain > 0.1);
      const r = (k: number) => hash2(cx * 13 + k, cz * 7 - k, seed + 105);
      const g = c.h;
      const snowy = c.biome === BiomeId.snow_mountain;
      switch (kind) {
        case "oak_small":
          tree(box, x, g, z, Block.OAK_LOG, Block.OAK_LEAVES, 4 + Math.floor(r(1) * 2), 2, r);
          break;
        case "oak":
          tree(box, x, g, z, Block.OAK_LOG, Block.OAK_LEAVES, 5 + Math.floor(r(1) * 3), 3, r);
          break;
        case "birch":
          tree(box, x, g, z, Block.BIRCH_LOG, Block.BIRCH_LEAVES, 6 + Math.floor(r(1) * 3), 2, r);
          break;
        case "oak_large":
          largeTree(box, x, g, z, 9 + Math.floor(r(1) * 4), 4 + Math.floor(r(2) * 2), r);
          break;
        case "giant":
          giantTree(box, x, g, z, 15 + Math.floor(r(1) * 7), r);
          break;
        case "pine":
          pine(box, x, g, z, 7 + Math.floor(r(1) * 7), snowy);
          break;
        case "bush":
          blob(box, x, g + 1, z, 1.2 + r(1) * 0.6, Block.OAK_LEAVES, r);
          break;
        case "boulder":
          blob(box, x, g + (r(2) < 0.5 ? 0 : 1), z, 1 + r(1) * 1.3, r(3) < 0.4 ? Block.MOSSY_BRICKS : r(3) < 0.7 ? Block.COBBLE : Block.STONE, r, true);
          break;
        case "log": {
          const len = 3 + Math.floor(r(1) * 4);
          const alongX = r(2) < 0.5;
          for (let i = 0; i < len; i++) box.place(alongX ? x + i : x, g + 1, alongX ? z : z + i, Block.OAK_LOG);
          break;
        }
        case "mushroom": {
          const h = 4 + Math.floor(r(1) * 3);
          for (let y = g + 1; y <= g + h; y++) box.set(x, y, z, Block.MUSHROOM_STEM);
          const R = 2 + (r(2) < 0.5 ? 1 : 0);
          for (let dz = -R; dz <= R; dz++)
            for (let dx = -R; dx <= R; dx++) {
              const d = Math.hypot(dx, dz);
              if (d > R + 0.3) continue;
              box.place(x + dx, g + h + 1, z + dz, Block.MUSHROOM_CAP);
              if (d > R - 0.8) box.place(x + dx, g + h, z + dz, Block.MUSHROOM_CAP);
            }
          break;
        }
        case "dead":
          for (let y = g + 1; y <= g + 2 + Math.floor(r(1) * 3); y++) box.set(x, y, z, Block.OAK_LOG);
          break;
        case "pond": {
          // Only on level ground
          const corners = [gen.column(x - 3, z - 3, newColumnInfo()).h, gen.column(x + 3, z + 3, newColumnInfo()).h, gen.column(x - 3, z + 3, newColumnInfo()).h, gen.column(x + 3, z - 3, newColumnInfo()).h];
          if (corners.some((h) => h !== g)) break;
          const R = 2 + r(1) * 1.6;
          for (let dz = -3; dz <= 3; dz++)
            for (let dx = -3; dx <= 3; dx++) {
              const d = Math.hypot(dx, dz * 1.2);
              if (d > R) continue;
              box.set(x + dx, g, z + dz, Block.WATER);
              if (d < R - 1) box.set(x + dx, g - 1, z + dz, Block.WATER);
              box.set(x + dx, d < R - 1 ? g - 2 : g - 1, z + dz, Block.CLAY);
              for (let y = g + 1; y < g + 4; y++) if (box.get(x + dx, y, z + dz) === Block.OAK_LEAVES) box.set(x + dx, y, z + dz, Block.AIR);
            }
          break;
        }
      }
    }

  // Coral reefs, seabed rocks and sea ice (columns inside the box only)
  for (let lz = 0; lz < box.sz; lz++)
    for (let lx = 0; lx < box.sx; lx++) {
      const c = colAt(lx, lz);
      const x = box.x0 + lx;
      const z = box.z0 + lz;
      if (c.water < 0 || c.liquid !== Block.WATER) continue;
      const depth = c.water - c.h;
      if (c.biome === BiomeId.cold_ocean && gen.n.noise2(x / 18, z / 18) > 0.5) box.set(x, c.water, z, Block.ICE);
      if ((c.biome === BiomeId.shallow_sea || c.biome === BiomeId.coast) && depth >= 3 && x > gen.region.coast.coldWestX) {
        const reef = gen.n3.noise2(x / 26, z / 26);
        if (reef > 0.25 && hash2(x, z, seed + 111) < 0.32) {
          const colors = [Block.CORAL_RED, Block.CORAL_YELLOW, Block.CORAL_BLUE, Block.CORAL_PINK];
          const block = colors[Math.floor(hash2(Math.floor(x / 3), Math.floor(z / 3), seed + 112) * 4)];
          const h = 1 + Math.floor(hash2(x, z, seed + 113) * Math.min(3, depth - 1));
          for (let y = c.h + 1; y <= c.h + h; y++) box.set(x, y, z, block);
        }
      }
      if ((c.biome === BiomeId.open_ocean || c.biome === BiomeId.deep_ocean || c.biome === BiomeId.abyss) && hash2(x, z, seed + 114) < 0.004) {
        for (let dy = 1; dy <= 2; dy++) box.set(x, c.h + dy, z, Block.STONE);
      }
    }
}

function tree(box: VoxelBox, x: number, g: number, z: number, log: number, leaves: number, height: number, radius: number, r: (k: number) => number): void {
  const top = g + height;
  for (let y = top - 2; y <= top + 1; y++) {
    const rad = y >= top ? radius - 1 : radius;
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) === rad && Math.abs(dz) === rad && (y >= top || r(dx * 5 + dz + y) < 0.6)) continue;
        box.place(x + dx, y, z + dz, leaves);
      }
  }
  box.set(x, g, z, Block.DIRT);
  for (let y = g + 1; y < top; y++) box.set(x, y, z, log);
}

function largeTree(box: VoxelBox, x: number, g: number, z: number, height: number, radius: number, r: (k: number) => number): void {
  const top = g + height;
  // Ellipsoid canopy with ragged edges
  for (let dy = -radius; dy <= radius - 1; dy++)
    for (let dz = -radius - 1; dz <= radius + 1; dz++)
      for (let dx = -radius - 1; dx <= radius + 1; dx++) {
        const q = (dx * dx + dz * dz) / (radius * radius) + (dy * dy) / ((radius * 0.75) ** 2);
        if (q > 1 + (r(dx * 31 + dz * 7 + dy) - 0.5) * 0.4) continue;
        box.place(x + dx, top + dy, z + dz, Block.OAK_LEAVES);
      }
  for (let y = g + 1; y < top; y++) {
    box.set(x, y, z, Block.OAK_LOG);
    if (y < g + 3) {
      box.set(x + 1, y, z, Block.OAK_LOG);
      box.set(x, y, z + 1, Block.OAK_LOG);
    }
  }
  // Branches
  for (let k = 0; k < 3; k++) {
    const a = r(10 + k) * Math.PI * 2;
    const by = top - 2 - k;
    for (let i = 1; i <= 3; i++) box.set(x + Math.round(Math.cos(a) * i), by + (i > 2 ? 1 : 0), z + Math.round(Math.sin(a) * i), Block.OAK_LOG);
  }
}

function giantTree(box: VoxelBox, x: number, g: number, z: number, height: number, r: (k: number) => number): void {
  const top = g + height;
  const R = 5;
  for (let dy = -3; dy <= 2; dy++)
    for (let dz = -R - 1; dz <= R + 2; dz++)
      for (let dx = -R - 1; dx <= R + 2; dx++) {
        const q = ((dx - 0.5) ** 2 + (dz - 0.5) ** 2) / (R * R) + (dy * dy) / 9;
        if (q > 1 + (r(dx * 17 + dz * 3 + dy) - 0.5) * 0.35) continue;
        box.place(x + dx, top + dy, z + dz, Block.JUNGLE_LEAVES);
      }
  // Lower leaf clumps on branches
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + r(k) * 0.8;
    const by = g + Math.floor(height * 0.55) + k;
    const ex = x + Math.round(Math.cos(a) * 4);
    const ez = z + Math.round(Math.sin(a) * 4);
    for (let i = 1; i <= 4; i++) box.set(x + Math.round(Math.cos(a) * i), by, z + Math.round(Math.sin(a) * i), Block.JUNGLE_LOG);
    blob(box, ex, by + 1, ez, 2, Block.JUNGLE_LEAVES, r);
  }
  for (let y = g; y < top; y++)
    for (let dx = 0; dx < 2; dx++) for (let dz = 0; dz < 2; dz++) box.set(x + dx, y, z + dz, Block.JUNGLE_LOG);
  // Buttress roots
  for (const [dx, dz] of [[-1, 0], [2, 1], [0, 2], [1, -1]] as const) for (let y = g; y < g + 2; y++) box.set(x + dx, y, z + dz, Block.JUNGLE_LOG);
}

function pine(box: VoxelBox, x: number, g: number, z: number, height: number, snowy: boolean): void {
  const top = g + height;
  let rad = 0;
  for (let y = top + 1; y >= g + 3; y--) {
    const fromTop = top + 1 - y;
    rad = fromTop === 0 ? 0 : 1 + Math.floor((fromTop % 3 === 0 ? fromTop * 0.32 : fromTop * 0.42) * 0.9);
    rad = Math.min(rad, 3);
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > rad + 1) continue;
        box.place(x + dx, y, z + dz, Block.PINE_LEAVES);
        if (snowy && box.get(x + dx, y + 1, z + dz) === Block.AIR && (fromTop % 3 === 1 || fromTop === 0)) box.place(x + dx, y + 1, z + dz, Block.SNOW);
      }
  }
  for (let y = g + 1; y < top; y++) box.set(x, y, z, Block.PINE_LOG);
}

function blob(box: VoxelBox, x: number, y: number, z: number, radius: number, block: number, r: (k: number) => number, replace = false): void {
  const R = Math.ceil(radius);
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy * 1.6 + dz * dz);
        if (d > radius + (r(dx * 7 + dy * 3 + dz) - 0.5) * 0.6) continue;
        if (replace) {
          const cur = box.get(x + dx, y + dy, z + dz);
          if (cur === Block.WATER || cur === Block.LAVA) continue;
          box.set(x + dx, y + dy, z + dz, block);
        } else box.place(x + dx, y + dy, z + dz, block);
      }
}

