import type { Rng } from "@shared/math/rng";
import { lerp } from "@shared/math/vec";
import type { CreatureAnim } from "@shared/types/game";
import { Block } from "@shared/world/blocks";
import type { Player } from "../player/Player";
import type { World } from "../world/World";
import type { WildCreature } from "./WildCreature";

export interface AIContext {
  world: World;
  rng: Rng;
  /** Seconds. */
  now: number;
  /** Seconds since this creature last updated (throttled creatures get larger steps). */
  dt: number;
  player: Player | null;
  playerDist: number;
  canEngage(p: Player): boolean;
  engage(c: WildCreature, p: Player): void;
}

/** How many ticks until a creature at this distance from the nearest player updates again (low-frequency AI far away). */
export function aiInterval(playerDist: number): number {
  if (playerDist < 24) return 2;
  if (playerDist < 48) return 4;
  if (playerDist < 72) return 10;
  return 20;
}

export function updateCreature(c: WildCreature, ctx: AIContext): void {
  if (c.state === "battle") {
    setAnim(c, "battle");
    return;
  }
  if (c.state === "capturing") return;
  if (c.special) {
    setAnim(c, c.mode === "fly" ? "fly" : "idle");
    return;
  }

  const speed = 1.4 * c.species.behavior.speed * (c.mode === "fly" ? 1.6 : c.mode === "swim" || c.mode === "dive" ? 0.9 : 1);
  const p = ctx.player;
  const d = ctx.playerDist;

  if (p && !p.battle && Math.abs(p.y - c.y) < 8) {
    if (d < 10) c.alertUntil = Math.max(c.alertUntil, ctx.now + (p.anim === "run" ? 6 : 2));
    const temper = c.species.behavior.temperament;
    const startled = d < 3.5 || ((p.anim === "run" || p.mounted !== null) && d < 8);
    if (temper === "timid" && startled && c.state !== "flee") {
      startFlee(c, p.x, p.z, ctx);
    } else if (temper === "aggressive" && d < 9 && c.state !== "approach" && c.state !== "flee" && ctx.canEngage(p)) {
      c.state = "approach";
      c.stateUntil = ctx.now + 8;
    } else if (temper === "neutral" && d < 5 && (c.state === "idle" || c.state === "wander")) {
      c.state = "watch";
      c.rotY = Math.atan2(p.x - c.x, p.z - c.z);
      c.stateUntil = ctx.now + 2.5;
      c.dirty = true;
    }
  }

  switch (c.state) {
    case "idle":
    case "watch":
      setAnim(c, restAnim(c));
      if (ctx.now >= c.stateUntil) pickWander(c, ctx);
      break;
    case "wander": {
      const r = moveToward(c, c.target!, speed, ctx, "walk");
      if (r !== "moving") rest(c, ctx, 2, 7);
      break;
    }
    case "flee": {
      const r = moveToward(c, c.target!, speed * 2.4, ctx, "run");
      if (r !== "moving" || ctx.now >= c.stateUntil) rest(c, ctx, 3, 6);
      break;
    }
    case "approach": {
      if (!p || p.battle || d > 16 || ctx.now >= c.stateUntil || !ctx.canEngage(p)) {
        rest(c, ctx, 3, 6);
        break;
      }
      if (d < 1.6 + c.width / 2) {
        ctx.engage(c, p);
        break;
      }
      moveToward(c, { x: p.x, y: p.y, z: p.z }, speed * 2.1, ctx, "run");
      break;
    }
  }
}

export function startFlee(c: WildCreature, fromX: number, fromZ: number, ctx: { now: number }): void {
  const ax = c.x - fromX;
  const az = c.z - fromZ;
  const len = Math.hypot(ax, az) || 1;
  c.target = { x: c.x + (ax / len) * 14, y: c.y, z: c.z + (az / len) * 14 };
  c.state = "flee";
  c.stateUntil = ctx.now + 4;
}

function restAnim(c: WildCreature): CreatureAnim {
  if (c.mode === "fly") return "fly";
  if (c.mode === "swim" || c.mode === "dive") return "swim";
  return "idle";
}

function rest(c: WildCreature, ctx: AIContext, min: number, max: number): void {
  c.state = "idle";
  c.target = null;
  c.stateUntil = ctx.now + ctx.rng.range(min, max);
  setAnim(c, restAnim(c));
}

function pickWander(c: WildCreature, ctx: AIContext): void {
  for (let i = 0; i < 6; i++) {
    const a = ctx.rng.range(0, Math.PI * 2);
    const r = ctx.rng.range(3, 10);
    const t = { x: c.home.x + Math.cos(a) * r, y: c.home.y + (c.mode === "dive" || c.mode === "fly" ? ctx.rng.range(-3, 3) : 0), z: c.home.z + Math.sin(a) * r };
    if (place(c, t.x, t.y, t.z, ctx) !== null) {
      c.target = t;
      c.state = "wander";
      return;
    }
  }
  c.stateUntil = ctx.now + 2;
}

/** Feet height a creature would have at x/z given its mode, or null if it cannot be there. */
function place(c: WildCreature, x: number, y: number, z: number, ctx: AIContext): number | null {
  const w = ctx.world;
  const clearance = Math.max(1, Math.ceil(c.height));
  switch (c.mode) {
    case "swim": {
      const surface = w.waterSurface(x, Math.floor(c.y) + 0.5, z) ?? w.waterSurface(x, c.y - 0.6, z);
      if (surface === null) return null;
      if (w.waterDepth(x, z) < 1) return null;
      return surface - Math.min(0.7, c.height * 0.45);
    }
    case "dive": {
      const ty = Math.floor(y);
      for (let k = 0; k < clearance; k++) if (w.block(x, ty + k, z) !== Block.WATER) return null;
      if (w.block(x, ty - 1, z) !== Block.WATER && !w.solid(x, ty - 1, z)) return null;
      return y;
    }
    case "fly": {
      const ceilingCheck = (yy: number) => {
        for (let k = 0; k <= clearance; k++) if (w.solid(x, yy + k, z)) return false;
        return true;
      };
      const floor = w.floorNear(x, y, z, clearance, 3, 30);
      const base = floor ?? Math.floor(y);
      let ty = Math.min(base + c.flyHeight, y + 2);
      ty = Math.max(ty, base + 1.5);
      if (!ceilingCheck(Math.floor(ty))) {
        ty = base + 1.2;
        if (!ceilingCheck(Math.floor(ty))) return null;
      }
      return ty;
    }
    default: {
      const feet = w.floorNear(x, c.y, z, clearance, 1, 3);
      if (feet === null) return null;
      if (w.inWater(x, feet, z) || w.inWater(x, feet + 0.5, z)) {
        if (!c.species.movement.water) return null;
      }
      return feet;
    }
  }
}

function moveToward(c: WildCreature, t: { x: number; y: number; z: number }, speed: number, ctx: AIContext, gait: "walk" | "run"): "moving" | "reached" | "blocked" {
  const dist = Math.hypot(t.x - c.x, t.z - c.z) + (c.mode === "dive" ? Math.abs(t.y - c.y) : 0);
  if (dist < 0.4) return "reached";
  const total = Math.min(dist, speed * ctx.dt);
  // Sub-steps so a long (throttled) move never skips through a wall
  const steps = Math.max(1, Math.ceil(total / 0.6));
  let moved = false;
  for (let i = 0; i < steps; i++) {
    const remain = Math.hypot(t.x - c.x, t.z - c.z);
    const step = total / steps;
    const k = remain > 0.001 ? Math.min(1, step / remain) : 0;
    const nx = c.x + (t.x - c.x) * k;
    const nz = c.z + (t.z - c.z) * k;
    const ty = c.mode === "dive" ? lerp(c.y, t.y, Math.min(1, step / Math.max(0.5, dist))) : t.y;
    const ny = place(c, nx, ty, nz, ctx);
    if (ny === null) {
      // Amphibious walkers slip into water; swimmers climb out onto banks
      if (c.mode === "walk" && c.species.movement.water && ctx.world.inWater(nx, c.y + 0.2, nz)) {
        c.mode = "swim";
        continue;
      }
      if (c.mode === "swim" && c.species.movement.land) {
        const feet = ctx.world.floorNear(nx, c.y + 1, nz, Math.ceil(c.height), 1, 2);
        if (feet !== null && !ctx.world.inWater(nx, feet, nz)) {
          c.mode = "walk";
          c.x = nx;
          c.z = nz;
          c.y = feet;
          moved = true;
          continue;
        }
      }
      if (!moved) return "blocked";
      break;
    }
    if (c.mode === "walk" && ny - c.y > 1.05) {
      if (!moved) return "blocked";
      break;
    }
    c.rotY = Math.atan2(nx - c.x, nz - c.z);
    c.x = nx;
    c.z = nz;
    c.y = c.mode === "fly" ? lerp(c.y, ny, 0.5) : ny;
    moved = true;
  }
  const anim: CreatureAnim = c.mode === "fly" ? "fly" : c.mode === "swim" || c.mode === "dive" ? "swim" : gait;
  setAnim(c, anim);
  c.dirty = true;
  return "moving";
}

function setAnim(c: WildCreature, anim: CreatureAnim): void {
  if (c.anim !== anim) {
    c.anim = anim;
    c.dirty = true;
  }
}
