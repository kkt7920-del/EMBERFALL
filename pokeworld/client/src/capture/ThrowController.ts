import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { BALL, minThrowSpeed, solveThrow } from "@shared/capture/ballPhysics";
import { CAPTURE_THROW_RANGE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import type { ClientMessage } from "@shared/protocol/messages";
import type { PlayerPrivateState } from "@shared/types/game";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { Avatar } from "../engine/Avatar";
import type { CameraRig } from "../engine/CameraRig";
import type { Controls } from "../engine/Input";
import type { Sfx } from "../engine/Audio";
import type { PlayerController } from "../engine/PlayerController";
import type { WildEntity, WildManager } from "../pokemon/WildManager";
import type { BallHud } from "../ui/BallHud";
import type { BallSystem } from "./BallSystem";

/** Hold longer than this to charge; shorter is a quick throw. */
const QUICK_MS = 180;
const CHARGE_SECONDS = 0.9;

export interface ThrowHost {
  db: ContentDB;
  world: VoxelWorld;
  state(): PlayerPrivateState | null;
  cam: CameraRig;
  controller: PlayerController;
  avatar: Avatar;
  balls: BallSystem;
  wild: WildManager;
  hud: BallHud;
  sfx: Sfx;
  send(m: ClientMessage): void;
  toast(text: string, tone: "info" | "good" | "bad"): void;
  /** Show key numbers on the hotbar (PC). */
  keyHints(): boolean;
}

/**
 * Holding and throwing Poké Balls. The ball is chosen on the hotbar (number
 * keys, mouse wheel) or the Ball Wheel; equipped, a reticle appears and the
 * camera moves over the shoulder. Press = wind up, short click = quick throw
 * with an ideal arc, hold = charge power, release = throw. The client predicts
 * the flight; the server simulates it and decides hit, miss and capture.
 */
export class ThrowController {
  equipped = false;
  selected = "poke_ball";
  /** Throws sent but not yet confirmed (optimistic counts). */
  private readonly pending = new Map<number, string>();
  private seq = 1;
  private pressAt = 0;
  private holding = false;
  target: WildEntity | null = null;
  /** Battle capture: only the battle's Pokémon can be targeted; cleared after one throw. */
  battleAim: { foeId: string; onThrown: () => void; onCancel: () => void } | null = null;
  private cooldownUntil = 0;

  constructor(private readonly host: ThrowHost) {}

  /** Owned capture balls in content order, with optimistic counts. */
  owned(): { id: string; count: number }[] {
    const inv = this.host.state()?.inventory ?? {};
    const out: { id: string; count: number }[] = [];
    for (const item of this.host.db.items.values()) {
      if (item.kind !== "capture") continue;
      const n = this.count(item.id, inv);
      if (n > 0 || item.id === this.selected) out.push({ id: item.id, count: n });
    }
    return out;
  }

  /** All ball types (for the wheel), with counts. */
  allBalls(): { id: string; count: number }[] {
    const inv = this.host.state()?.inventory ?? {};
    return [...this.host.db.items.values()].filter((i) => i.kind === "capture").map((i) => ({ id: i.id, count: this.count(i.id, inv) }));
  }

  private count(id: string, inv: Record<string, number>): number {
    let n = inv[id] ?? 0;
    for (const p of this.pending.values()) if (p === id) n--;
    return Math.max(0, n);
  }

  /** Server confirmed (or rejected) a throw: stop counting it as pending. */
  confirm(seq: number): void {
    this.pending.delete(seq);
  }

  setEquipped(on: boolean): void {
    if (on === this.equipped) return;
    if (on && this.count(this.selected, this.host.state()?.inventory ?? {}) <= 0) {
      const any = this.owned().find((o) => o.count > 0);
      if (!any) {
        this.host.toast("몬스터볼이 없다! 마을 상점에서 살 수 있다.", "bad");
        return;
      }
      this.selected = any.id;
    }
    this.equipped = on;
    this.holding = false;
    this.host.avatar.holdBall(on ? this.host.db.items.get(this.selected)?.ball : undefined);
    this.host.avatar.windup(0);
    if (on) this.host.sfx.play("ball_equip");
  }

  select(id: string): void {
    if (this.host.db.items.get(id)?.kind !== "capture") return;
    this.selected = id;
    this.host.sfx.play("ball_select");
    if (this.equipped) this.host.avatar.holdBall(this.host.db.items.get(id)?.ball);
  }

  /** Starts aiming at the battle opponent (battle "포획"). */
  enterBattleAim(foeId: string, ball: string, onThrown: () => void, onCancel: () => void): void {
    this.select(ball);
    this.battleAim = { foeId, onThrown, onCancel };
    this.equipped = false;
    this.setEquipped(true);
  }

  cancelBattleAim(): void {
    const b = this.battleAim;
    this.battleAim = null;
    this.setEquipped(false);
    b?.onCancel();
  }

  /**
   * Soft lock-on: the Pokémon whose body is closest to the crosshair ray,
   * within a tolerance that grows a little with distance (small Pokémon at
   * 20 m stay targetable), and not hidden behind blocks.
   */
  /** Last throw, for tests and debugging. */
  lastThrow: { from: number[]; aim: number[]; vel: number[]; yaw: number; dir: number[]; target: string | null; power: number | null } | null = null;

  private rayTarget(): WildEntity | null {
    const cam = this.host.cam.camera;
    const o = cam.position;
    const d = this.host.cam.forward();
    const player = this.host.controller.pos;
    let best: WildEntity | null = null;
    let bestScore = 1;
    for (const w of this.host.wild.all()) {
      if (w.held || !w.view.root.isEnabled()) continue;
      if (this.battleAim && w.snap.id !== this.battleAim.foeId) continue;
      const p = w.view.root.position;
      if (Vector3.Distance(p, player) > CAPTURE_THROW_RANGE) continue;
      const h = Math.max(0.4, w.view.height);
      const vx = p.x - o.x;
      const vy = p.y + h / 2 - o.y;
      const vz = p.z - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t <= 0) continue;
      const perp = Math.hypot(vx - d.x * t, vy - d.y * t, vz - d.z * t);
      let allowance = Math.max(w.view.width, h) / 2 + 0.25 + t * 0.045;
      // Sticky lock: a locked Pokémon stays targeted a little outside the cone (it moves while you charge)
      if (w === this.target) allowance *= 1.8;
      const score = perp / allowance;
      if (score < bestScore) {
        bestScore = score;
        best = w;
      }
    }
    if (best) {
      // Line of sight to the middle or the top of the body
      const p = best.view.root.position;
      const h = Math.max(0.4, best.view.height);
      // (from the camera, or from the hand when the camera is pushed against a wall)
      const hand = this.hand();
      const visible = [o, hand].some((from) =>
        [h * 0.5, h * 0.95].some((oy) => {
          const v = new Vector3(p.x - from.x, p.y + oy - from.y, p.z - from.z);
          const len = v.length();
          v.scaleInPlace(1 / len);
          const hit = this.host.world.raycast(from.x, from.y, from.z, v.x, v.y, v.z, len);
          return !hit || hit.dist >= len - 0.6;
        }),
      );
      if (!visible) return null;
    }
    return best;
  }

  /** Where the ball leaves the hand (right shoulder). */
  hand(): Vector3 {
    const p = this.host.controller.pos;
    const yaw = this.host.cam.yaw;
    return new Vector3(p.x + Math.cos(yaw) * 0.32, p.y + 1.5, p.z - Math.sin(yaw) * 0.32);
  }

  update(dt: number, c: Controls, allowed: boolean, keepInHand = true): void {
    const host = this.host;
    if (c.ball.select !== null && allowed) {
      const list = this.owned().filter((o) => o.count > 0);
      const pick = list[c.ball.select];
      if (pick) {
        this.select(pick.id);
        this.setEquipped(true);
      }
    }
    if (c.ball.cycle && this.equipped) {
      const list = this.owned().filter((o) => o.count > 0);
      if (list.length) {
        const i = list.findIndex((o) => o.id === this.selected);
        const next = list[(((i + c.ball.cycle) % list.length) + list.length) % list.length];
        this.select(next.id);
      }
    }
    if (c.pressed.has("capture") && allowed) {
      if (this.battleAim) this.cancelBattleAim();
      else this.setEquipped(!this.equipped);
    }
    if (!allowed && this.equipped && !this.battleAim) {
      // A battle puts the ball away; a panel or dialog only pauses aiming (the ball stays in hand)
      if (!keepInHand) this.setEquipped(false);
      else {
        this.holding = false;
        this.target = null;
        host.hud.setAim(false, false, null);
        host.hud.setPower(null);
        host.avatar.windup(0);
        return;
      }
    }

    host.cam.aiming = this.equipped;
    host.controller.strafe = this.equipped;
    this.target = this.equipped ? this.rayTarget() : null;
    const t = this.target;
    const s = t ? host.db.species.get(t.snap.species) : undefined;
    host.hud.setAim(this.equipped, !!t, t && s ? `${s.name}${t.snap.alpha ? " ★ALPHA" : ""}\nLv. ${t.snap.level}` : null);
    host.hud.setBalls(this.selected, this.equipped, this.owned(), host.keyHints());

    if (!this.equipped) {
      host.hud.setPower(null);
      return;
    }
    const now = performance.now();
    if (c.ball.down && now > this.cooldownUntil) {
      if (this.count(this.selected, host.state()?.inventory ?? {}) <= 0) {
        host.toast(`${host.db.items.get(this.selected)?.name ?? "볼"}이(가) 없다.`, "bad");
      } else {
        this.holding = true;
        this.pressAt = now;
      }
    }
    if (this.holding) {
      const held = (now - this.pressAt) / 1000;
      const charge = held * 1000 < QUICK_MS ? 0 : Math.min(1, (held - QUICK_MS / 1000) / CHARGE_SECONDS);
      host.avatar.windup(Math.min(1, held * 5));
      host.hud.setPower(held * 1000 < QUICK_MS ? null : charge);
      if (c.ball.up || !c.ball.held) {
        this.holding = false;
        host.hud.setPower(null);
        this.throwBall(held * 1000 < QUICK_MS ? null : charge);
      }
    } else host.avatar.windup(0);
  }

  /** power: null = quick throw (ideal arc to the target), else 0..1 charge. */
  private throwBall(power: number | null): void {
    const host = this.host;
    const from = this.hand();
    const cam = host.cam.camera;
    const dir = host.cam.forward();
    let aim: Vector3;
    if (this.target) {
      const p = this.target.view.root.position;
      aim = new Vector3(p.x, p.y + Math.max(0.3, this.target.view.height * 0.45), p.z);
    } else {
      // Ignore blocks between the camera and the player (camera pushed into a wall or tree)
      const skip = Math.max(0, Vector3.Dot(from.subtract(cam.position), dir)) + 0.3;
      const o = cam.position.add(dir.scale(skip));
      const hit = host.world.raycast(o.x, o.y, o.z, dir.x, dir.y, dir.z, 40);
      aim = hit ? o.add(dir.scale(hit.dist)) : cam.position.add(dir.scale(22));
    }
    const dx = aim.x - from.x;
    const dy = aim.y - from.y;
    const dz = aim.z - from.z;
    const ideal = Math.min(BALL.maxThrowSpeed, Math.max(10, minThrowSpeed(dx, dy, dz) * 1.12));
    const speed = power === null ? ideal : 9 + power * (BALL.maxThrowSpeed - 9);
    let v = solveThrow(dx, dy, dz, speed);
    if (!v) {
      // Not enough power to reach: throw at 40° along the aim direction (falls short)
      const flat = Math.hypot(dx, dz) || 1;
      v = { vx: (dx / flat) * Math.cos(0.7) * speed, vy: Math.sin(0.7) * speed, vz: (dz / flat) * Math.cos(0.7) * speed };
    }
    const vel = new Vector3(v.vx, v.vy, v.vz);
    this.lastThrow = { from: from.asArray(), aim: aim.asArray(), vel: vel.asArray(), yaw: host.cam.yaw, dir: dir.asArray(), target: this.target?.snap.id ?? null, power };
    const seq = this.seq++;
    this.pending.set(seq, this.selected);
    host.balls.throwLocal(seq, this.selected, from, vel);
    host.send({ type: "BALL_THROW", seq, ball: this.selected, x: from.x, y: from.y, z: from.z, vx: vel.x, vy: vel.y, vz: vel.z });
    host.avatar.playThrow();
    host.controller.rotY = Math.atan2(dx, dz);
    this.cooldownUntil = performance.now() + 480;
    setTimeout(() => this.pending.delete(seq), 4000);

    if (this.battleAim) {
      const b = this.battleAim;
      this.battleAim = null;
      this.equipped = false;
      host.avatar.holdBall(undefined);
      b.onThrown();
    } else if (this.count(this.selected, host.state()?.inventory ?? {}) <= 0) {
      // Out of this ball: keep the hand ready with another type, or put away
      const next = this.owned().find((o) => o.count > 0);
      if (next) this.select(next.id);
      else setTimeout(() => this.setEquipped(false), 500);
    }
  }
}

/** Ray vs axis-aligned box; returns distance along the ray or null. */
export function rayBox(o: Vector3, d: Vector3, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  const lo = [minX, minY, minZ];
  const hi = [maxX, maxY, maxZ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ds[i]) < 1e-9) {
      if (os[i] < lo[i] || os[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - os[i]) / ds[i];
    let t2 = (hi[i] - os[i]) / ds[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
