import type { Rng } from "@shared/math/rng";
import { dist2, lerp } from "@shared/math/vec";
import type { CreatureAnim } from "@shared/types/game";
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

/** How many ticks until a creature at this distance from the nearest player updates again. */
export function aiInterval(playerDist: number): number {
  if (playerDist < 32) return 2;
  if (playerDist < 64) return 5;
  return 20;
}

export function updateCreature(c: WildCreature, ctx: AIContext): void {
  if (c.state === "battle") {
    setAnim(c, "battle");
    return;
  }
  if (c.special) {
    setAnim(c, c.mode === "fly" ? "fly" : "idle");
    return;
  }

  const speed = 1.5 * c.species.behavior.speed;
  const p = ctx.player;
  const d = ctx.playerDist;

  if (p && !p.battle) {
    const temper = c.species.behavior.temperament;
    const startled = d < 4 || ((p.anim === "run" || p.mounted !== null) && d < 9);
    if (temper === "timid" && startled && c.state !== "flee") {
      const ax = c.x - p.x;
      const az = c.z - p.z;
      const len = Math.hypot(ax, az) || 1;
      c.target = { x: c.x + (ax / len) * 14, z: c.z + (az / len) * 14 };
      c.state = "flee";
      c.stateUntil = ctx.now + 4;
    } else if (temper === "aggressive" && d < 10 && c.state !== "approach" && ctx.canEngage(p)) {
      c.state = "approach";
      c.stateUntil = ctx.now + 8;
    } else if (temper === "neutral" && d < 5 && (c.state === "idle" || c.state === "wander")) {
      c.state = "watch";
      c.rotY = Math.atan2(p.x - c.x, p.z - c.z);
      c.stateUntil = ctx.now + 2;
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
      if (r !== "moving") rest(c, ctx, 2, 6);
      break;
    }
    case "flee": {
      const r = moveToward(c, c.target!, speed * 2.6, ctx, "run");
      if (r !== "moving" || ctx.now >= c.stateUntil) rest(c, ctx, 3, 6);
      break;
    }
    case "approach": {
      if (!p || p.battle || d > 16 || ctx.now >= c.stateUntil || !ctx.canEngage(p)) {
        rest(c, ctx, 3, 6);
        break;
      }
      if (d < 1.9) {
        ctx.engage(c, p);
        break;
      }
      moveToward(c, { x: p.x, z: p.z }, speed * 2.2, ctx, "run");
      break;
    }
  }
}

function restAnim(c: WildCreature): CreatureAnim {
  if (c.mode === "fly") return "fly";
  if (c.mode === "swim" || c.anim === "swim") return "swim";
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
    const r = ctx.rng.range(3, 9);
    const t = { x: c.home.x + Math.cos(a) * r, z: c.home.z + Math.sin(a) * r };
    if (passable(c, t.x, t.z, ctx)) {
      c.target = t;
      c.state = "wander";
      return;
    }
  }
  c.stateUntil = ctx.now + 2;
}

function canSwim(c: WildCreature): boolean {
  return c.species.behavior.movement.includes("swim");
}

function passable(c: WildCreature, x: number, z: number, ctx: AIContext): boolean {
  const w = ctx.world;
  if (!w.inBounds(c.zone, x, z, 2)) return false;
  const depth = w.waterDepth(c.zone, x, z);
  if (c.mode === "swim") return depth >= 1;
  if (c.mode === "fly") return true;
  if (depth > 0.5 && !canSwim(c)) return false;
  return true;
}

function moveToward(c: WildCreature, t: { x: number; z: number }, speed: number, ctx: AIContext, gait: "walk" | "run"): "moving" | "reached" | "blocked" {
  const dist = dist2(c.x, c.z, t.x, t.z);
  if (dist < 0.4) return "reached";

  const step = Math.min(dist, speed * ctx.dt);
  const nx = c.x + ((t.x - c.x) / dist) * step;
  const nz = c.z + ((t.z - c.z) / dist) * step;
  const w = ctx.world;

  if (!passable(c, nx, nz, ctx)) return "blocked";

  let ny = c.y;
  let anim: CreatureAnim = gait;
  if (c.mode === "fly") {
    const ground = w.ground(c.zone, nx, nz, 0.4);
    let target = ground + c.flyHeight;
    const ceiling = w.ceiling(c.zone);
    if (ceiling !== null) target = Math.min(target, ceiling - 1.5);
    ny = lerp(c.y, target, Math.min(1, ctx.dt * 2));
    anim = "fly";
  } else if (c.mode === "swim" || w.waterDepth(c.zone, nx, nz) > 0.5) {
    ny = w.swimHeight(c.zone);
    anim = "swim";
  } else {
    const ground = w.ground(c.zone, nx, nz, 0.3);
    if (ground - c.y > 1.1) return "blocked";
    ny = ground;
  }

  c.rotY = Math.atan2(nx - c.x, nz - c.z);
  c.x = nx;
  c.z = nz;
  c.y = ny;
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
