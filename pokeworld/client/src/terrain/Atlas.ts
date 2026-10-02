import { Rng } from "@shared/math/rng";
import { ATLAS_COLUMNS, Tile } from "@shared/world/blocks";

export const TILE_PX = 16;

type Painter = (g: CanvasRenderingContext2D, rng: Rng) => void;

const rgb = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;

function noise(g: CanvasRenderingContext2D, rng: Rng, base: [number, number, number], spread: number): void {
  for (let y = 0; y < TILE_PX; y++)
    for (let x = 0; x < TILE_PX; x++) {
      const v = (rng.next() - 0.5) * spread;
      g.fillStyle = rgb(base[0] + v, base[1] + v, base[2] + v);
      g.fillRect(x, y, 1, 1);
    }
}

function speckle(g: CanvasRenderingContext2D, rng: Rng, color: string, count: number, size = 1): void {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) g.fillRect(rng.int(0, TILE_PX - size), rng.int(0, TILE_PX - size), size, size);
}

function bricks(g: CanvasRenderingContext2D, rng: Rng, base: [number, number, number], mortar: string): void {
  noise(g, rng, base, 22);
  g.fillStyle = mortar;
  for (let row = 0; row < 4; row++) {
    g.fillRect(0, row * 4 + 3, TILE_PX, 1);
    const off = row % 2 ? 4 : 0;
    for (let x = off; x < TILE_PX; x += 8) g.fillRect(x, row * 4, 1, 3);
  }
}

const P: Record<number, Painter> = {
  [Tile.GRASS_TOP]: (g, r) => {
    noise(g, r, [104, 178, 74], 34);
    speckle(g, r, "#8fd06a", 14);
    speckle(g, r, "#4e9a3c", 10);
  },
  [Tile.GRASS_SIDE]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    speckle(g, r, "#6e4c30", 12);
    g.fillStyle = "#6cb24a";
    g.fillRect(0, 0, TILE_PX, 4);
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.45)) g.fillRect(x, 4, 1, r.int(1, 3));
  },
  [Tile.DIRT]: (g, r) => {
    noise(g, r, [134, 96, 62], 26);
    speckle(g, r, "#6e4c30", 16);
    speckle(g, r, "#a07a52", 8);
  },
  [Tile.SAND]: (g, r) => {
    noise(g, r, [226, 208, 150], 20);
    speckle(g, r, "#f2e4b8", 10);
    speckle(g, r, "#c8b07a", 8);
  },
  [Tile.STONE]: (g, r) => {
    noise(g, r, [132, 132, 136], 24);
    g.fillStyle = "#6c6c72";
    for (let i = 0; i < 4; i++) g.fillRect(r.int(0, 12), r.int(0, 15), r.int(2, 5), 1);
  },
  [Tile.GRAVEL]: (g, r) => {
    noise(g, r, [128, 122, 116], 30);
    speckle(g, r, "#5a5652", 20, 2);
    speckle(g, r, "#b0aaa2", 12);
  },
  [Tile.SNOW]: (g, r) => noise(g, r, [236, 242, 250], 12),
  [Tile.SNOW_SIDE]: (g, r) => {
    noise(g, r, [132, 132, 136], 24);
    g.fillStyle = "#eef3fa";
    g.fillRect(0, 0, TILE_PX, 4);
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.5)) g.fillRect(x, 4, 1, r.int(1, 2));
  },
  [Tile.LOG_SIDE]: (g, r) => {
    noise(g, r, [112, 82, 52], 18);
    g.fillStyle = "#5c4026";
    for (let x = 1; x < TILE_PX; x += 3) g.fillRect(x, 0, 1, TILE_PX);
  },
  [Tile.LOG_TOP]: (g, r) => {
    noise(g, r, [176, 138, 90], 14);
    g.strokeStyle = "#8a6440";
    for (const rad of [2, 4.5, 7]) {
      g.beginPath();
      g.arc(8, 8, rad, 0, Math.PI * 2);
      g.stroke();
    }
  },
  [Tile.PLANK]: (g, r) => {
    noise(g, r, [176, 132, 84], 16);
    g.fillStyle = "#7c5a36";
    for (let y = 3; y < TILE_PX; y += 4) g.fillRect(0, y, TILE_PX, 1);
    for (let y = 0; y < 4; y++) g.fillRect(((y * 7) % 13) + 1, y * 4, 1, 3);
  },
  [Tile.ROOF]: (g, r) => {
    noise(g, r, [214, 214, 214], 18);
    g.fillStyle = "rgba(0,0,0,0.22)";
    for (let y = 3; y < TILE_PX; y += 4) g.fillRect(0, y, TILE_PX, 1);
    for (let y = 0; y < 4; y++) for (let x = y % 2 ? 2 : 6; x < TILE_PX; x += 8) g.fillRect(x, y * 4, 1, 3);
  },
  [Tile.PATH]: (g, r) => {
    noise(g, r, [196, 168, 118], 20);
    speckle(g, r, "#a68a5e", 10, 2);
    speckle(g, r, "#e0c896", 6);
  },
  [Tile.BRICK]: (g, r) => bricks(g, r, [168, 156, 136], "#7e7464"),
  [Tile.MOSSY]: (g, r) => {
    bricks(g, r, [150, 146, 126], "#6e6a58");
    speckle(g, r, "#5a9a46", 22, 2);
  },
  [Tile.CAVE_STONE]: (g, r) => {
    noise(g, r, [82, 76, 92], 22);
    speckle(g, r, "#5a5266", 18, 2);
  },
  [Tile.CRYSTAL]: (g, r) => {
    noise(g, r, [150, 200, 240], 30);
    g.fillStyle = "#e8f8ff";
    for (let i = 0; i < 5; i++) g.fillRect(r.int(1, 13), r.int(1, 13), 2, 2);
    g.fillStyle = "#a080e0";
    for (let i = 0; i < 4; i++) g.fillRect(r.int(0, 14), r.int(0, 14), 2, 1);
  },
  [Tile.CLAY]: (g, r) => noise(g, r, [150, 156, 168], 18),
  [Tile.WALL]: (g, r) => {
    noise(g, r, [238, 230, 214], 10);
    g.fillStyle = "rgba(0,0,0,0.08)";
    g.fillRect(0, 15, TILE_PX, 1);
  },
  [Tile.LEAVES]: (g, r) => {
    noise(g, r, [74, 150, 64], 40);
    speckle(g, r, "#2f6e2c", 22, 2);
    speckle(g, r, "#8ccc6a", 10);
  },
  [Tile.WATER]: (g, r) => noise(g, r, [60, 130, 210], 16),
  [Tile.FOREST_TOP]: (g, r) => {
    noise(g, r, [70, 136, 60], 30);
    speckle(g, r, "#3a7a34", 16);
    speckle(g, r, "#8a6a40", 4);
  },
  [Tile.FOREST_SIDE]: (g, r) => {
    noise(g, r, [124, 90, 60], 24);
    g.fillStyle = "#4e8a3e";
    g.fillRect(0, 0, TILE_PX, 4);
    for (let x = 0; x < TILE_PX; x++) if (r.chance(0.5)) g.fillRect(x, 4, 1, r.int(1, 3));
  },
  [Tile.WINDOW_WALL]: (g, r) => {
    noise(g, r, [238, 230, 214], 10);
    g.fillStyle = "#4a6a90";
    g.fillRect(4, 4, 8, 8);
    g.fillStyle = "#9cc8f0";
    g.fillRect(5, 5, 3, 3);
  },
};

/** Paints the 8x8 terrain atlas (16 px tiles, pixel-art style). Deterministic. */
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
