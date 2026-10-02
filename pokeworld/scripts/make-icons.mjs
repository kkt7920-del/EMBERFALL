// Generates the PWA icons (PNG) procedurally — no image assets or native deps.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Original emblem: a teal "world orb" with a leaf and a gold star, over a sky gradient.
// `pad` shrinks it for maskable icons.
const icon = (pad, rounded) => (u, v) => {
  const sky = [Math.round(28 + 30 * v), Math.round(59 + 60 * v), Math.round(114 + 80 * (1 - v))];
  if (rounded) {
    const cx = Math.max(Math.abs(u - 0.5) - 0.32, 0);
    const cy = Math.max(Math.abs(v - 0.5) - 0.32, 0);
    if (Math.hypot(cx, cy) > 0.18) return [0, 0, 0, 0];
  }
  const s = 1 - pad * 2;
  const x = (u - 0.5) / s;
  const y = (v - 0.5) / s + 0.04;
  const d = Math.hypot(x, y);
  // five-point star test
  const star = (sx, sy, r) => {
    const a = Math.atan2(sy, sx);
    const k = Math.cos(Math.PI / 5) / Math.cos(((((a + Math.PI / 2) % ((2 * Math.PI) / 5)) + (2 * Math.PI) / 5) % ((2 * Math.PI) / 5)) - Math.PI / 5);
    return Math.hypot(sx, sy) < r * (0.45 + 0.55 * (k - Math.cos(Math.PI / 5)) / (1 - Math.cos(Math.PI / 5)));
  };
  if (d < 0.36) {
    if (d > 0.335) return [20, 40, 50, 255];
    if (star(x, y + 0.01, 0.17)) return [255, 214, 92, 255];
    // continents: blocky green patches
    const gx = Math.floor((x + 1) * 9);
    const gy = Math.floor((y + 1) * 9);
    const land = ((gx * 7 + gy * 13) % 5 === 0 || (gx * 3 + gy * 5) % 7 === 0) && d < 0.31;
    const shade = 1 - Math.max(0, x + y) * 0.35;
    const base = land ? [96, 186, 92] : [44, 168, 190];
    const hl = Math.hypot(x + 0.13, y + 0.14) < 0.06 ? 60 : 0;
    return [Math.min(255, base[0] * shade + hl), Math.min(255, base[1] * shade + hl), Math.min(255, base[2] * shade + hl), 255];
  }
  // leaf sprout on top
  if (y < -0.32 && y > -0.5 && Math.abs(x - 0.06 + (y + 0.41) * 0.5) < 0.05 + (y + 0.5) * 0.25) return [120, 205, 80, 255];
  return [...sky, 255];
};

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, icon(0.06, true)));
writeFileSync("public/icons/icon-512.png", png(512, icon(0.06, true)));
writeFileSync("public/icons/icon-maskable-512.png", png(512, icon(0.16, false)));
writeFileSync("public/icons/apple-touch-icon.png", png(180, icon(0.1, false)));
console.log("icons written to public/icons");
