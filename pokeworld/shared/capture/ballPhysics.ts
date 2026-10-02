import { Block, SOLID } from "../world/blocks";
import type { VoxelWorld } from "../world/voxelWorld";

/** Poké Ball projectile constants (shared so client prediction matches the server). */
export const BALL = {
  radius: 0.17,
  gravity: 20,
  /** Linear air drag per second. */
  airDrag: 0.06,
  /** Bounciness on blocks. */
  restitution: 0.42,
  /** Ground rolling deceleration (m/s^2) plus a speed-proportional part (grass, dirt). */
  rollFriction: 6,
  rollDamping: 1.6,
  /** Horizontal speed kept through a bounce off the ground. */
  bounceGrip: 0.62,
  restSpeed: 0.3,
  waterDrag: 2.4,
  minThrowSpeed: 6,
  maxThrowSpeed: 30,
  /** Fixed integration step: identical results on every machine. */
  step: 1 / 120,
  /** Balls that miss stay on the ground this long (s) before vanishing. */
  groundLifetime: 300,
  pickupRange: 1.8,
} as const;

export interface BallBody {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Visual spin (radians) around x and z. */
  rx: number;
  rz: number;
  grounded: boolean;
  resting: boolean;
  inWater: boolean;
  /** Ball time (s) since the throw. */
  t: number;
  bounces: number;
  /** Fixed steps not yet simulated. */
  acc: number;
}

export type BallEvent = { kind: "bounce"; speed: number; x: number; y: number; z: number } | { kind: "splash" } | { kind: "rest" };

export function newBall(x: number, y: number, z: number, vx: number, vy: number, vz: number): BallBody {
  return { x, y, z, vx, vy, vz, rx: 0, rz: 0, grounded: false, resting: false, inWater: false, t: 0, bounces: 0, acc: 0 };
}

function overlaps(world: VoxelWorld, x: number, y: number, z: number): boolean {
  const r = BALL.radius;
  const x0 = Math.floor(x - r);
  const x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r);
  const y1 = Math.floor(y + r);
  const z0 = Math.floor(z - r);
  const z1 = Math.floor(z + r);
  for (let yy = y0; yy <= y1; yy++)
    for (let zz = z0; zz <= z1; zz++)
      for (let xx = x0; xx <= x1; xx++) {
        const b = world.block(xx, yy, zz);
        if (SOLID[b] || b === Block.LAVA) return true;
      }
  return false;
}

/** One fixed step. Returns events (bounces, splash, rest). */
function fixedStep(world: VoxelWorld, b: BallBody, out: BallEvent[]): void {
  const h = BALL.step;
  b.t += h;
  if (b.resting) return;
  const block = world.block(b.x, b.y, b.z);
  const wasInWater = b.inWater;
  b.inWater = block === Block.WATER;
  if (b.inWater && !wasInWater) out.push({ kind: "splash" });

  if (b.inWater) {
    const k = Math.exp(-BALL.waterDrag * h);
    b.vx *= k;
    b.vz *= k;
    b.vy *= k;
    // Float up to the surface
    const surfaceAbove = world.block(b.x, b.y + 0.25, b.z) !== Block.WATER;
    b.vy += (surfaceAbove ? 0 : 9) * h;
    if (surfaceAbove) b.vy *= 0.9;
  } else {
    b.vy -= BALL.gravity * h;
    const k = Math.exp(-BALL.airDrag * h);
    b.vx *= k;
    b.vz *= k;
  }

  // Axis-separated moves with bounces
  const nx = b.x + b.vx * h;
  if (overlaps(world, nx, b.y, b.z)) {
    if (Math.abs(b.vx) > 1.2) out.push({ kind: "bounce", speed: Math.abs(b.vx), x: b.x, y: b.y, z: b.z });
    b.vx = -b.vx * BALL.restitution;
    b.bounces++;
  } else b.x = nx;
  const nz = b.z + b.vz * h;
  if (overlaps(world, b.x, b.y, nz)) {
    if (Math.abs(b.vz) > 1.2) out.push({ kind: "bounce", speed: Math.abs(b.vz), x: b.x, y: b.y, z: b.z });
    b.vz = -b.vz * BALL.restitution;
    b.bounces++;
  } else b.z = nz;
  const ny = b.y + b.vy * h;
  b.grounded = false;
  if (overlaps(world, b.x, ny, b.z)) {
    if (b.vy < 0) {
      // Settle exactly on the block top
      b.y = Math.floor(ny - BALL.radius) + 1 + BALL.radius + 0.001;
      if (overlaps(world, b.x, b.y, b.z)) b.y = ny - b.vy * h;
      if (-b.vy > 1.5) {
        out.push({ kind: "bounce", speed: -b.vy, x: b.x, y: b.y, z: b.z });
        b.vy = -b.vy * BALL.restitution;
        b.vx *= BALL.bounceGrip;
        b.vz *= BALL.bounceGrip;
        b.bounces++;
      } else {
        b.vy = 0;
        b.grounded = true;
      }
    } else b.vy = -b.vy * 0.3;
  } else b.y = ny;

  // Rolling friction and spin
  const hs = Math.hypot(b.vx, b.vz);
  if (b.grounded && hs > 0) {
    const ns = Math.max(0, hs * Math.exp(-BALL.rollDamping * h) - BALL.rollFriction * h);
    b.vx *= ns / hs;
    b.vz *= ns / hs;
  }
  b.rx += (b.vz / BALL.radius) * h * (b.grounded ? 1 : 0.35);
  b.rz -= (b.vx / BALL.radius) * h * (b.grounded ? 1 : 0.35);

  const speed = Math.hypot(b.vx, b.vy, b.vz);
  if ((b.grounded || (b.inWater && world.block(b.x, b.y + 0.25, b.z) !== Block.WATER)) && speed < BALL.restSpeed) {
    b.resting = true;
    b.vx = b.vy = b.vz = 0;
    out.push({ kind: "rest" });
  }
  if (b.y < -10) {
    b.resting = true;
    out.push({ kind: "rest" });
  }
}

/**
 * Advances the ball by `dt` seconds of ball time in fixed steps. `onStep` is
 * called after every step with the previous position (for hit tests); return
 * true from it to stop simulating (the ball hit something).
 */
export function stepBall(world: VoxelWorld, b: BallBody, dt: number, onStep?: (px: number, py: number, pz: number) => boolean): BallEvent[] {
  const events: BallEvent[] = [];
  b.acc += dt;
  while (b.acc >= BALL.step) {
    b.acc -= BALL.step;
    if (b.resting) {
      b.t += BALL.step;
      continue;
    }
    const px = b.x;
    const py = b.y;
    const pz = b.z;
    fixedStep(world, b, events);
    if (onStep && onStep(px, py, pz)) break;
  }
  return events;
}

/** Segment (p0 -> p1) against an AABB grown by the ball radius. */
export function segmentHitsBox(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const r = BALL.radius;
  let tmin = 0;
  let tmax = 1;
  const d = [x1 - x0, y1 - y0, z1 - z0];
  const o = [x0, y0, z0];
  const lo = [minX - r, minY - r, minZ - r];
  const hi = [maxX + r, maxY + r, maxZ + r];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return false;
      continue;
    }
    let t1 = (lo[i] - o[i]) / d[i];
    let t2 = (hi[i] - o[i]) / d[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

/** Launch velocity that lands a ball thrown at `speed` on the target point (low arc), or null if out of reach. */
export function solveThrow(dx: number, dy: number, dz: number, speed: number): { vx: number; vy: number; vz: number } | null {
  const g = BALL.gravity;
  const d = Math.hypot(dx, dz);
  if (d < 0.01) return { vx: 0, vy: speed, vz: 0 };
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0) return null;
  const angle = Math.atan2(v2 - Math.sqrt(disc), g * d);
  const h = Math.cos(angle) * speed;
  return { vx: (dx / d) * h, vy: Math.sin(angle) * speed, vz: (dz / d) * h };
}

/** Minimum launch speed that reaches the point (45° optimum for flat ground, adjusted for height). */
export function minThrowSpeed(dx: number, dy: number, dz: number): number {
  const g = BALL.gravity;
  const d = Math.hypot(dx, dz);
  return Math.sqrt(g * (dy + Math.hypot(d, dy)));
}
