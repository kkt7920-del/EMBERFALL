import { Rng } from "@shared/math/rng";
import { ATLAS_COLUMNS, Tile } from "@shared/world/blocks";

export const TILE_PX = 16;

type Painter = (g: CanvasRenderingContext2D, rng: Rng) => void;
type RGB = [number, number, number];

const rgb = (r: number, g: number, b: number, a = 1) => `rgba(${Math.max(0, Math.min(255, r | 0))},${Math.max(0, Math.min(255, g | 0))},${Math.max(0, Math.min(255, b | 0))},${a})`;

function noise(g: CanvasRenderingContext2D, rng: Rng, base: RGB, spread: number, x0 = 0, y0 = 0, w = TILE_PX, h = TILE_PX): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const v = (rng.next() - 0.5) * spread;
      g.fillStyle = rgb(base[0] + v, base[1] + v, base[2] + v);
      g.fillRect(x, y, 1, 1);
    }
}

function speckle(g: CanvasRenderingContext2D, rng: Rng, color: string, count: number, size = 1): void {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) g.fillRect(rng.int(0, TILE_PX - size), rng.int(0, TILE_PX - size), size, size);
}

function bricks(g: CanvasRenderingContext2D, rng: Rng, base: RGB, mortar: string, rows = 4): void {
  noise(g, rng, base, 22);
  g.fillStyle = mortar;
  const rh = TILE_PX / rows;
  for (let row = 0; row < rows; row++) {
    g.fillRect(0, row * rh + rh - 1, TILE_PX, 1);
    const off = row % 2 ? 4 : 0;
    for (let x = off; x < TILE_PX; x += 8) g.fillRect(x, row * rh, 1, rh - 1);
  }
}

function stone(g: CanvasRenderingContext2D, r: Rng, base: RGB): void {
  noise(g, r, base, 22);
  g.fillStyle = rgb(base[0] - 30, base[1] - 30, base[2] - 30);
  for (let i = 0; i < 5; i++) g.fillRect(r.int(0, 12), r.int(0, 15), r.int(2, 5), 1);
  g.fillStyle = rgb(base[0] + 22, base[1] + 22, base[2] + 22);
  for (let i = 0; i < 3; i++) g.fillRect(r.int(0, 13), r.int(0, 15), r.int(1, 3), 1);
}

function ore(g: CanvasRenderingContext2D, r: Rng, base: RGB, color: string, light: string): void {
  stone(g, r, base);
  for (let i = 0; i < 5; i++) {
    const x = r.int(1, 12);
    const y = r.int(1, 12);
    g.fillStyle = color;
    g.fillRect(x, y, 3, 2);
    g.fillRect(x + 1, y - 1, 1, 1);
    g.fillStyle = light;
    g.fillRect(x, y, 1, 1);
  }
}

function logSide(g: CanvasRenderingContext2D, r: Rng, base: RGB, dark: string): void {
  noise(g, r, base, 16);
  g.fillStyle = dark;
  for (let x = 1; x < TILE_PX; x += 3) for (let y = 0; y < TILE_PX; y++) if (r.chance(0.8)) g.fillRect(x + (r.chance(0.2) ? 1 : 0), y, 1, 1);
}

function logTop(g: CanvasRenderingContext2D, r: Rng, bark: RGB, wood: RGB, ring: string): void {
  noise(g, r, bark, 14);
  noise(g, r, wood, 14, 1, 1, 14, 14);
  g.fillStyle = ring;
  for (const rad of [2, 4, 6]) {
    g.fillRect(8 - rad, 8 - rad, rad * 2, 1);
    g.fillRect(8 - rad, 8 + rad - 1, rad * 2, 1);
    g.fillRect(8 - rad, 8 - rad, 1, rad * 2);
    g.fillRect(8 + rad - 1, 8 - rad, 1, rad * 2);
  }
}

/** Grey leaves: the block tint supplies the colour. */
function leaves(g: CanvasRenderingContext2D, r: Rng, base: number, spread: number): void {
  for (let y = 0; y < TILE_PX; y++)
    for (let x = 0; x < TILE_PX; x++) {
      const v = base + (r.next() - 0.5) * spread;
      const hole = r.chance(0.13);
      g.fillStyle = hole ? rgb(v * 0.35, v * 0.35, v * 0.35) : rgb(v, v, v);
      g.fillRect(x, y, 1, 1);
    }
}

function clear(g: CanvasRenderingContext2D): void {
  g.clearRect(0, 0, TILE_PX, TILE_PX);
}

function blade(g: CanvasRenderingContext2D, x: number, top: number, color: string, lean = 0): void {
  g.fillStyle = color;
  for (let y = TILE_PX - 1; y >= top; y--) g.fillRect(Math.round(x + ((TILE_PX - 1 - y) * lean) / 6), y, 1, 1);
}

function flower(g: CanvasRenderingContext2D, r: Rng, petal: string, center: string): void {
  clear(g);
  blade(g, 8, 7, "#3d8a2e");
  blade(g, 6, 12, "#4ea03a", -0.5);
  blade(g, 10, 12, "#4ea03a", 0.5);
  g.fillStyle = petal;
  g.fillRect(6, 4, 5, 3);
  g.fillRect(7, 3, 3, 5);
  g.fillStyle = center;
  g.fillRect(8, 5, 1, 1);
  void r;
}

const P: Record<number, Painter> = {
  [Tile.GRASS_TOP]: (g, r) => {
    leaves(g, r, 205, 46);
    speckle(g, r, rgb(235, 235, 235), 10);
  },
  [Tile.GRASS_SIDE]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    speckle(g, r, "#6e4c30", 12);
    noise(g, r, [104, 172, 70], 26, 0, 0, TILE_PX, 3);
    g.fillStyle = "#62a844";
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.55)) g.fillRect(x, 3, 1, r.int(1, 3));
  },
  [Tile.DIRT]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    speckle(g, r, "#6e4c30", 16);
    speckle(g, r, "#a07a52", 8);
  },
  [Tile.STONE]: (g, r) => stone(g, r, [128, 128, 132]),
  [Tile.SAND]: (g, r) => {
    noise(g, r, [226, 210, 154], 18);
    speckle(g, r, "#f2e4b8", 10);
    speckle(g, r, "#c8b07a", 8);
  },
  [Tile.GRAVEL]: (g, r) => {
    noise(g, r, [128, 122, 116], 30);
    speckle(g, r, "#5a5652", 20, 2);
    speckle(g, r, "#b0aaa2", 12);
  },
  [Tile.CLAY]: (g, r) => {
    noise(g, r, [156, 162, 176], 14);
    speckle(g, r, "#aab0bc", 8, 2);
  },
  [Tile.SNOW]: (g, r) => {
    noise(g, r, [238, 244, 252], 10);
    speckle(g, r, "#d6e2f0", 8);
  },
  [Tile.SNOW_SIDE]: (g, r) => {
    stone(g, r, [128, 128, 132]);
    noise(g, r, [238, 244, 252], 8, 0, 0, TILE_PX, 4);
    g.fillStyle = "#eef3fa";
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.5)) g.fillRect(x, 4, 1, r.int(1, 2));
  },
  [Tile.SNOWY_GRASS_SIDE]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    noise(g, r, [238, 244, 252], 8, 0, 0, TILE_PX, 4);
    g.fillStyle = "#eef3fa";
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.5)) g.fillRect(x, 4, 1, r.int(1, 2));
  },
  [Tile.ICE]: (g, r) => {
    noise(g, r, [150, 196, 244], 14);
    g.fillStyle = "rgba(255,255,255,0.6)";
    for (let i = 0; i < 4; i++) g.fillRect(r.int(0, 10), r.int(0, 15), r.int(3, 6), 1);
  },
  [Tile.PACKED_ICE]: (g, r) => {
    noise(g, r, [130, 172, 230], 18);
    speckle(g, r, "#dbeaff", 14);
  },
  [Tile.DEEPSLATE]: (g, r) => {
    noise(g, r, [74, 74, 82], 16);
    g.fillStyle = "#4a4a54";
    for (let y = 1; y < TILE_PX; y += 3) for (let x = 0; x < TILE_PX; x++) if (r.chance(0.5)) g.fillRect(x, y, 1, 1);
  },
  [Tile.DEEPSLATE_TOP]: (g, r) => {
    noise(g, r, [78, 78, 86], 16);
    speckle(g, r, "#56565e", 20, 2);
  },
  [Tile.DEEPSLATE_ORE]: (g, r) => {
    noise(g, r, [74, 74, 82], 16);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = "#e8c440";
      g.fillRect(r.int(1, 12), r.int(1, 13), 2, 2);
    }
  },
  [Tile.OAK_LOG]: (g, r) => logSide(g, r, [112, 84, 52], "#5c4026"),
  [Tile.OAK_LOG_TOP]: (g, r) => logTop(g, r, [96, 72, 44], [176, 138, 90], "#8a6440"),
  [Tile.OAK_LEAVES]: (g, r) => leaves(g, r, 170, 70),
  [Tile.BIRCH_LOG]: (g, r) => {
    noise(g, r, [226, 224, 214], 10);
    g.fillStyle = "#3a3a36";
    for (let i = 0; i < 7; i++) g.fillRect(r.int(0, 12), r.int(0, 15), r.int(2, 4), 1);
  },
  [Tile.BIRCH_LOG_TOP]: (g, r) => logTop(g, r, [220, 218, 208], [200, 176, 130], "#a8865a"),
  [Tile.BIRCH_LEAVES]: (g, r) => leaves(g, r, 190, 60),
  [Tile.PINE_LOG]: (g, r) => logSide(g, r, [76, 54, 34], "#3c2814"),
  [Tile.PINE_LOG_TOP]: (g, r) => logTop(g, r, [70, 50, 30], [150, 112, 70], "#6a4a2a"),
  [Tile.PINE_LEAVES]: (g, r) => {
    leaves(g, r, 150, 60);
    g.fillStyle = rgb(110, 110, 110);
    for (let x = 0; x < TILE_PX; x += 2) for (let y = (x / 2) % 3; y < TILE_PX; y += 3) g.fillRect(x, y, 1, 1);
  },
  [Tile.JUNGLE_LOG]: (g, r) => {
    logSide(g, r, [92, 72, 40], "#4a3a1a");
    speckle(g, r, "#5a7a30", 8);
  },
  [Tile.JUNGLE_LOG_TOP]: (g, r) => logTop(g, r, [84, 64, 36], [168, 128, 80], "#7a5a30"),
  [Tile.JUNGLE_LEAVES]: (g, r) => leaves(g, r, 160, 80),
  [Tile.WATER]: (g, r) => {
    noise(g, r, [62, 128, 214], 12);
    g.fillStyle = "rgba(170,210,255,0.55)";
    for (let i = 0; i < 6; i++) g.fillRect(r.int(0, 11), r.int(0, 15), r.int(3, 5), 1);
  },
  [Tile.COAL_ORE]: (g, r) => ore(g, r, [128, 128, 132], "#2a2a2a", "#4a4a4a"),
  [Tile.COPPER_ORE]: (g, r) => ore(g, r, [128, 128, 132], "#c86a3a", "#e89a5a"),
  [Tile.IRON_ORE]: (g, r) => ore(g, r, [128, 128, 132], "#c8a488", "#e8d0b8"),
  [Tile.GOLD_ORE]: (g, r) => ore(g, r, [128, 128, 132], "#e8c440", "#fff08a"),
  [Tile.CRYSTAL]: (g, r) => {
    noise(g, r, [130, 196, 240], 30);
    g.fillStyle = "#e8f8ff";
    for (let i = 0; i < 6; i++) g.fillRect(r.int(1, 13), r.int(1, 13), 2, 2);
    g.fillStyle = "#a080e0";
    for (let i = 0; i < 4; i++) g.fillRect(r.int(0, 14), r.int(0, 14), 2, 1);
  },
  [Tile.ANCIENT_STONE]: (g, r) => bricks(g, r, [176, 164, 132], "#857a5e", 2),
  [Tile.ANCIENT_CARVED]: (g, r) => {
    bricks(g, r, [176, 164, 132], "#857a5e", 2);
    g.fillStyle = "#5ae0e8";
    g.fillRect(4, 3, 8, 1);
    g.fillRect(4, 12, 8, 1);
    g.fillRect(7, 4, 2, 8);
    g.fillRect(5, 7, 6, 2);
  },
  [Tile.LAVA]: (g, r) => {
    noise(g, r, [236, 110, 28], 40);
    speckle(g, r, "#ffd84a", 16, 2);
    speckle(g, r, "#b03a10", 10, 2);
  },
  [Tile.MAGMA]: (g, r) => {
    noise(g, r, [70, 36, 28], 20);
    g.fillStyle = "#ff8a2a";
    for (let i = 0; i < 6; i++) g.fillRect(r.int(0, 12), r.int(0, 15), r.int(2, 4), 1);
  },
  [Tile.BASALT]: (g, r) => {
    noise(g, r, [62, 60, 64], 14);
    g.fillStyle = "#38363a";
    for (let x = 2; x < TILE_PX; x += 4) g.fillRect(x, 0, 1, TILE_PX);
  },
  [Tile.BASALT_TOP]: (g, r) => {
    noise(g, r, [66, 64, 68], 14);
    g.strokeStyle = "#3a383c";
    g.strokeRect(2.5, 2.5, 11, 11);
  },
  [Tile.OBSIDIAN]: (g, r) => {
    noise(g, r, [28, 20, 44], 14);
    speckle(g, r, "#5a3a8a", 10);
  },
  [Tile.BEDROCK]: (g, r) => {
    noise(g, r, [70, 70, 70], 60);
  },
  [Tile.PATH_TOP]: (g, r) => {
    noise(g, r, [180, 150, 100], 22);
    speckle(g, r, "#8e7048", 12, 2);
    speckle(g, r, "#d4b882", 6);
  },
  [Tile.PATH_SIDE]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    noise(g, r, [180, 150, 100], 18, 0, 0, TILE_PX, 2);
  },
  [Tile.PLANKS]: (g, r) => {
    noise(g, r, [176, 136, 86], 14);
    g.fillStyle = "#7c5a36";
    for (let y = 3; y < TILE_PX; y += 4) g.fillRect(0, y, TILE_PX, 1);
    for (let y = 0; y < 4; y++) g.fillRect(((y * 7) % 13) + 1, y * 4, 1, 3);
  },
  [Tile.DARK_PLANKS]: (g, r) => {
    noise(g, r, [96, 66, 40], 12);
    g.fillStyle = "#4a3018";
    for (let y = 3; y < TILE_PX; y += 4) g.fillRect(0, y, TILE_PX, 1);
    for (let y = 0; y < 4; y++) g.fillRect(((y * 5) % 11) + 2, y * 4, 1, 3);
  },
  [Tile.COBBLE]: (g, r) => {
    noise(g, r, [120, 120, 124], 30);
    g.fillStyle = "#5c5c62";
    for (let i = 0; i < 9; i++) {
      const x = r.int(0, 12);
      const y = r.int(0, 12);
      g.fillRect(x, y, 4, 1);
      g.fillRect(x, y, 1, 3);
    }
  },
  [Tile.STONE_BRICKS]: (g, r) => bricks(g, r, [140, 140, 144], "#6a6a70", 2),
  [Tile.MOSSY_BRICKS]: (g, r) => {
    bricks(g, r, [140, 140, 144], "#6a6a70", 2);
    speckle(g, r, "#5a9a46", 24, 2);
  },
  [Tile.BRICK]: (g, r) => bricks(g, r, [170, 84, 64], "#d8c8b8"),
  [Tile.PLASTER]: (g, r) => {
    noise(g, r, [240, 234, 220], 8);
    g.fillStyle = "rgba(0,0,0,0.06)";
    g.fillRect(0, 15, TILE_PX, 1);
  },
  [Tile.GLASS]: (g, r) => {
    noise(g, r, [150, 196, 230], 10);
    g.fillStyle = "#e8f2fa";
    g.fillRect(0, 0, TILE_PX, 1);
    g.fillRect(0, 0, 1, TILE_PX);
    g.fillRect(0, 15, TILE_PX, 1);
    g.fillRect(15, 0, 1, TILE_PX);
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.fillRect(3, 3, 1, 4);
    g.fillRect(4, 3, 2, 1);
  },
  [Tile.ROOF]: (g, r) => {
    noise(g, r, [214, 214, 214], 18);
    g.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 3; y < TILE_PX; y += 4) g.fillRect(0, y, TILE_PX, 1);
    for (let y = 0; y < 4; y++) for (let x = y % 2 ? 2 : 6; x < TILE_PX; x += 8) g.fillRect(x, y * 4, 1, 3);
  },
  [Tile.CORAL]: (g, r) => {
    noise(g, r, [220, 220, 220], 30);
    g.fillStyle = "rgba(0,0,0,0.25)";
    for (let i = 0; i < 10; i++) g.fillRect(r.int(0, 14), r.int(0, 14), 2, 2);
  },
  [Tile.SANDSTONE]: (g, r) => {
    noise(g, r, [216, 198, 140], 12);
    g.fillStyle = "#c2a870";
    g.fillRect(0, 4, TILE_PX, 1);
    g.fillRect(0, 11, TILE_PX, 1);
  },
  [Tile.SANDSTONE_TOP]: (g, r) => noise(g, r, [222, 204, 148], 12),
  [Tile.PODZOL_TOP]: (g, r) => {
    noise(g, r, [110, 78, 42], 26);
    speckle(g, r, "#5a8a3a", 14);
    speckle(g, r, "#c08a4a", 8);
  },
  [Tile.PODZOL_SIDE]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    noise(g, r, [110, 78, 42], 20, 0, 0, TILE_PX, 3);
  },
  [Tile.MUSHROOM_CAP]: (g, r) => {
    noise(g, r, [204, 44, 40], 18);
    g.fillStyle = "#f6f0e6";
    for (let i = 0; i < 6; i++) g.fillRect(r.int(1, 12), r.int(1, 12), 3, 3);
  },
  [Tile.MUSHROOM_STEM]: (g, r) => {
    noise(g, r, [226, 220, 204], 10);
    speckle(g, r, "#c8c0a8", 10);
  },
  [Tile.MOSS]: (g, r) => {
    noise(g, r, [88, 140, 56], 30);
    speckle(g, r, "#3e7a2a", 18, 2);
  },
  [Tile.LAMP]: (g, r) => {
    noise(g, r, [255, 214, 120], 26);
    g.strokeStyle = "#6a4a20";
    g.strokeRect(0.5, 0.5, 15, 15);
    g.fillStyle = "#fff6d0";
    g.fillRect(6, 6, 4, 4);
  },
  [Tile.ASH]: (g, r) => {
    noise(g, r, [96, 92, 92], 24);
    speckle(g, r, "#4a4646", 16, 2);
  },
  [Tile.DOOR]: (g, r) => {
    noise(g, r, [110, 76, 46], 12);
    g.fillStyle = "#4a3018";
    g.strokeStyle = "#4a3018";
    g.strokeRect(1.5, 1.5, 13, 13);
    g.fillRect(11, 8, 2, 2);
  },
  [Tile.BOOKSHELF]: (g, r) => {
    noise(g, r, [176, 136, 86], 14);
    for (const y of [1, 9]) {
      g.fillStyle = "#3a2410";
      g.fillRect(1, y, 14, 6);
      for (let x = 2; x < 14; x += 2) {
        g.fillStyle = ["#a83a3a", "#3a6aa8", "#3a8a4a", "#c8a03a", "#7a4aa8"][r.int(0, 4)];
        g.fillRect(x, y + r.int(0, 1), 1, 6 - r.int(0, 1));
      }
    }
  },
  // ---------------------------------------------------------------- flora sprites
  [Tile.FLORA_GRASS]: (g, r) => {
    clear(g);
    for (let i = 0; i < 9; i++) blade(g, r.int(1, 14), r.int(4, 11), ["#5aa63c", "#4a9632", "#6ab84a"][r.int(0, 2)], r.range(-1, 1));
  },
  [Tile.FLORA_FERN]: (g, r) => {
    clear(g);
    for (let i = 0; i < 6; i++) {
      const x = r.int(2, 13);
      const lean = r.range(-1.5, 1.5);
      blade(g, x, r.int(2, 6), "#3e8a34", lean);
      g.fillStyle = "#5aa848";
      for (let y = 4; y < 14; y += 2) g.fillRect(Math.round(x + ((15 - y) * lean) / 6) + (y % 4 ? 1 : -1), y, 1, 1);
    }
  },
  [Tile.FLORA_FLOWER_RED]: (g, r) => flower(g, r, "#e83a3a", "#ffe04a"),
  [Tile.FLORA_FLOWER_YELLOW]: (g, r) => flower(g, r, "#f6d23a", "#e88a2a"),
  [Tile.FLORA_FLOWER_BLUE]: (g, r) => flower(g, r, "#5a8af0", "#ffffff"),
  [Tile.FLORA_MUSHROOM_RED]: (g) => {
    clear(g);
    g.fillStyle = "#efe6d6";
    g.fillRect(7, 9, 2, 7);
    g.fillStyle = "#d8302c";
    g.fillRect(4, 5, 8, 4);
    g.fillRect(5, 4, 6, 1);
    g.fillStyle = "#ffffff";
    g.fillRect(6, 5, 1, 1);
    g.fillRect(9, 6, 1, 1);
  },
  [Tile.FLORA_MUSHROOM_BROWN]: (g) => {
    clear(g);
    g.fillStyle = "#e6dcc8";
    g.fillRect(7, 10, 2, 6);
    g.fillStyle = "#9a6a42";
    g.fillRect(4, 7, 8, 3);
    g.fillRect(5, 6, 6, 1);
  },
  [Tile.FLORA_SEAGRASS]: (g, r) => {
    clear(g);
    for (let i = 0; i < 7; i++) blade(g, r.int(1, 14), r.int(1, 8), ["#2e8a5a", "#3aa06a", "#24704a"][r.int(0, 2)], r.range(-2, 2));
  },
  [Tile.FLORA_KELP]: (g, r) => {
    clear(g);
    g.fillStyle = "#4a7a2a";
    for (let y = 0; y < TILE_PX; y++) g.fillRect(7 + Math.round(Math.sin(y / 2.5)), y, 2, 1);
    g.fillStyle = "#5e9a34";
    for (let y = 1; y < TILE_PX; y += 4) {
      g.fillRect(4, y, 3, 2);
      g.fillRect(10, y + 2, 3, 2);
    }
    void r;
  },
  [Tile.FLORA_DEAD_BUSH]: (g, r) => {
    clear(g);
    for (let i = 0; i < 5; i++) blade(g, r.int(3, 12), r.int(4, 9), "#8a6a3a", r.range(-2.5, 2.5));
  },
  [Tile.FLORA_REED]: (g, r) => {
    clear(g);
    for (let i = 0; i < 4; i++) blade(g, 3 + i * 3, 0, ["#7aa84a", "#6a9a3a"][i % 2], r.range(-0.4, 0.4));
  },
  [Tile.FLORA_GLOW_SHROOM]: (g) => {
    clear(g);
    g.fillStyle = "#b8f0ff";
    g.fillRect(7, 9, 2, 7);
    g.fillStyle = "#5ae0ff";
    g.fillRect(4, 5, 8, 4);
    g.fillRect(5, 4, 6, 1);
    g.fillStyle = "#e8ffff";
    g.fillRect(6, 6, 2, 1);
  },
};

/** Paints the 16 x 16 tile terrain atlas (16 px pixel-art tiles). Deterministic. */
export function paintAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ATLAS_COLUMNS * TILE_PX;
  const g = canvas.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  for (let t = 0; t < ATLAS_COLUMNS * ATLAS_COLUMNS; t++) {
    const painter = P[t];
    if (!painter) continue;
    const tx = (t % ATLAS_COLUMNS) * TILE_PX;
    const ty = Math.floor(t / ATLAS_COLUMNS) * TILE_PX;
    g.save();
    g.translate(tx, ty);
    g.beginPath();
    g.rect(0, 0, TILE_PX, TILE_PX);
    g.clip();
    painter(g, new Rng(1000 + t));
    g.restore();
  }
  return canvas;
}
