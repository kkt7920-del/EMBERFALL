import { SOLID } from "./blocks";
import type { VoxelWorld } from "./voxelWorld";

/** Axis-aligned body standing on its feet at (x, y, z). */
export interface Body {
  x: number;
  y: number;
  z: number;
  halfW: number;
  height: number;
}

const EPS = 0.001;

/** Whether an AABB overlaps any solid block. */
export function boxBlocked(world: VoxelWorld, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
  const x0 = Math.floor(minX + EPS);
  const x1 = Math.floor(maxX - EPS);
  const y0 = Math.floor(minY + EPS);
  const y1 = Math.floor(maxY - EPS);
  const z0 = Math.floor(minZ + EPS);
  const z1 = Math.floor(maxZ - EPS);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) if (SOLID[world.block(x, y, z)]) return true;
  return false;
}

export function bodyBlocked(world: VoxelWorld, b: Body, x = b.x, y = b.y, z = b.z): boolean {
  return boxBlocked(world, x - b.halfW, y, z - b.halfW, x + b.halfW, y + b.height, z + b.halfW);
}

export interface MoveResult {
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  /** Landed on something while moving down. */
  grounded: boolean;
  /** Climbed a step this move. */
  stepped: boolean;
}

/**
 * Moves a body through the voxel world with collision, one axis at a time
 * (Minecraft-style), in small sub-steps so fast bodies never tunnel. When a
 * horizontal move is blocked by a ledge no higher than `stepUp`, the body
 * climbs it.
 */
export function moveBody(world: VoxelWorld, b: Body, dx: number, dy: number, dz: number, stepUp = 0): MoveResult {
  const res: MoveResult = { hitX: false, hitY: false, hitZ: false, grounded: false, stepped: false };
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.4));
  const sx = dx / steps;
  const sy = dy / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    // Vertical
    if (sy !== 0 && !res.hitY) {
      const ny = b.y + sy;
      if (bodyBlocked(world, b, b.x, ny, b.z)) {
        res.hitY = true;
        const prev = b.y;
        const snap = sy < 0 ? Math.floor(ny + EPS) + 1 : Math.floor(ny + b.height - EPS) - b.height - EPS;
        const valid = sy < 0 ? snap <= prev + EPS : snap >= prev - EPS;
        b.y = valid && !bodyBlocked(world, b, b.x, snap, b.z) ? snap : prev;
        if (sy < 0) res.grounded = true;
      } else b.y = ny;
    }
    // Horizontal, x then z
    for (const axis of [0, 1] as const) {
      const d = axis === 0 ? sx : sz;
      if (d === 0 || (axis === 0 ? res.hitX : res.hitZ)) continue;
      const nx = axis === 0 ? b.x + d : b.x;
      const nz = axis === 1 ? b.z + d : b.z;
      if (!bodyBlocked(world, b, nx, b.y, nz)) {
        b.x = nx;
        b.z = nz;
        continue;
      }
      // Try to climb a step
      if (stepUp > 0) {
        const up = Math.floor(b.y + EPS) + 1 - b.y;
        if (up > 0 && up <= stepUp + EPS && !bodyBlocked(world, b, nx, b.y + up, nz) && !bodyBlocked(world, b, b.x, b.y + up, b.z)) {
          b.y += up;
          b.x = nx;
          b.z = nz;
          res.stepped = true;
          continue;
        }
      }
      if (axis === 0) {
        res.hitX = true;
        const snap = d > 0 ? Math.floor(nx + b.halfW - EPS) - b.halfW - EPS : Math.floor(nx - b.halfW + EPS) + 1 + b.halfW + EPS;
        if ((d > 0 ? snap >= b.x : snap <= b.x) && !bodyBlocked(world, b, snap, b.y, b.z)) b.x = snap;
      } else {
        res.hitZ = true;
        const snap = d > 0 ? Math.floor(nz + b.halfW - EPS) - b.halfW - EPS : Math.floor(nz - b.halfW + EPS) + 1 + b.halfW + EPS;
        if ((d > 0 ? snap >= b.z : snap <= b.z) && !bodyBlocked(world, b, b.x, b.y, snap)) b.z = snap;
      }
    }
  }
  return res;
}

/** Whether there is solid ground just under the body's feet. */
export function onGround(world: VoxelWorld, b: Body): boolean {
  return boxBlocked(world, b.x - b.halfW, b.y - 0.06, b.z - b.halfW, b.x + b.halfW, b.y - 0.001, b.z + b.halfW);
}

/** Pushes a body that ended up inside blocks (teleport, server correction) up to free space. */
export function unstick(world: VoxelWorld, b: Body, maxRise = 40): void {
  for (let i = 0; i < maxRise && bodyBlocked(world, b); i++) b.y = Math.floor(b.y) + 1;
}
