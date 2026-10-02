import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { BALL, type BallBody, newBall, stepBall } from "@shared/capture/ballPhysics";
import type { ContentDB } from "@shared/data/contentDb";
import type { BallSnapshot, ServerMessageOf } from "@shared/protocol/messages";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { CameraRig } from "../engine/CameraRig";
import type { Sfx } from "../engine/Audio";
import type { WildManager } from "../pokemon/WildManager";
import { BallModel, type CaptureFx, ballLook } from "./BallVisuals";

/** Must match the server's CAPTURE_TIMING (server/src/sim/Simulation.ts). */
export const TIMING = { absorb: 1.2, drop: 0.55, shake: 0.95, critical: 0.7, result: 0.45 };

interface ClientBall {
  key: string;
  owner: string;
  mine: boolean;
  seq: number;
  item: string;
  body: BallBody;
  model: BallModel;
  trail: { follow(at: Vector3): void; stop(): void } | null;
  state: "flying" | "resting" | "sequence";
  /** Smoothly corrects toward the server's resting position. */
  restTarget: Vector3 | null;
  flySound: number;
  /** Pickup animation (flying to the player). */
  pickup: { t: number; to: () => Vector3 } | null;
}

export interface BallSystemHost {
  selfId(): string;
  playerHand(): Vector3;
  speciesName(id: string): string;
  /** Owner-only result banner. */
  gotcha(text: string, sub: string): void;
  toast(text: string, tone: "info" | "good" | "bad"): void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Every Poké Ball the player can see: own throws (predicted with the shared
 * physics, then confirmed by the server), other players' throws, balls lying
 * on the ground, and the capture sequences the server reports.
 */
export class BallSystem {
  private readonly balls = new Map<string, ClientBall>();
  private readonly mats = new Map<string, StandardMaterial>();
  /** Wild entity ids inside a running capture sequence. */
  readonly busy = new Set<string>();
  private readonly onSequenceEnd = new Map<string, (() => void)[]>();
  private time = 0;

  constructor(
    private readonly scene: Scene,
    private readonly db: ContentDB,
    private readonly world: VoxelWorld,
    private readonly wild: WildManager,
    private readonly fx: CaptureFx,
    private readonly sfx: Sfx,
    private readonly cam: CameraRig,
    private readonly host: BallSystemHost,
  ) {}

  get count(): number {
    return this.balls.size;
  }

  /** Balls on the ground (for the HUD hint and tests). */
  resting(): { key: string; x: number; y: number; z: number; mine: boolean }[] {
    return [...this.balls.values()].filter((b) => b.state === "resting").map((b) => ({ key: b.key, x: b.body.x, y: b.body.y, z: b.body.z, mine: b.mine }));
  }

  flying(): { key: string; x: number; y: number; z: number }[] {
    return [...this.balls.values()].filter((b) => b.state === "flying").map((b) => ({ key: b.key, x: b.body.x, y: b.body.y, z: b.body.z }));
  }

  private make(key: string, owner: string, seq: number, item: string, body: BallBody): ClientBall {
    const model = new BallModel(this.scene, ballLook(this.db, item), this.mats, `ball_${key}`);
    model.root.position.set(body.x, body.y, body.z);
    const b: ClientBall = {
      key,
      owner,
      mine: owner === this.host.selfId(),
      seq,
      item,
      body,
      model,
      trail: body.resting ? null : this.fx.trail(),
      state: body.resting ? "resting" : "flying",
      restTarget: null,
      flySound: 0,
      pickup: null,
    };
    this.balls.set(key, b);
    return b;
  }

  /** Our own throw: starts simulating immediately (the server confirms with BALL_SPAWN). */
  throwLocal(seq: number, item: string, origin: Vector3, vel: Vector3): void {
    const body = newBall(origin.x, origin.y, origin.z, vel.x, vel.y, vel.z);
    this.make(`seq:${seq}`, this.host.selfId(), seq, item, body);
    this.sfx.play("ball_throw");
    this.cam.assist = origin.clone();
  }

  onSpawn(s: BallSnapshot): void {
    if (this.balls.has(s.id)) return;
    if (s.owner === this.host.selfId()) {
      const predicted = this.balls.get(`seq:${s.seq}`);
      if (predicted) {
        this.balls.delete(predicted.key);
        predicted.key = s.id;
        this.balls.set(s.id, predicted);
        return;
      }
    }
    const body = newBall(s.x, s.y, s.z, s.vx, s.vy, s.vz);
    body.t = s.t;
    body.resting = s.resting;
    this.make(s.id, s.owner, s.seq, s.ball, body);
  }

  onUpdate(m: ServerMessageOf<"BALL_UPDATE">): void {
    const b = this.balls.get(m.id);
    if (!b) return;
    switch (m.kind) {
      case "rest":
        if (b.state === "sequence") return;
        b.restTarget = new Vector3(m.x, m.y, m.z);
        b.body.resting = true;
        b.body.vx = b.body.vy = b.body.vz = 0;
        this.settle(b);
        break;
      case "deflect":
        b.body.x = m.x;
        b.body.y = m.y;
        b.body.z = m.z;
        b.body.vx = m.vx ?? 0;
        b.body.vy = m.vy ?? 0;
        b.body.vz = m.vz ?? 0;
        b.body.resting = false;
        b.state = "flying";
        this.sfx.play("ball_bounce");
        this.fx.impactSpark(new Vector3(m.x, m.y, m.z));
        break;
      case "pickup":
        b.pickup = { t: 0, to: () => this.host.playerHand() };
        if (b.mine) this.sfx.play("ball_pickup");
        break;
      case "remove":
        if (b.state === "sequence") return; // the sequence removes it
        this.remove(b);
        break;
    }
  }

  private settle(b: ClientBall): void {
    b.state = "resting";
    b.trail?.stop();
    b.trail = null;
    if (b.mine && this.cam.assist) this.cam.assist = null;
  }

  private remove(b: ClientBall): void {
    b.trail?.stop();
    b.model.dispose();
    this.balls.delete(b.key);
    if (b.mine && this.cam.assist) this.cam.assist = null;
  }

  /** Resolves when the capture sequence for a wild entity has finished playing. */
  whenDone(targetId: string): Promise<void> {
    if (!this.busy.has(targetId)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.onSequenceEnd.get(targetId) ?? [];
      list.push(resolve);
      this.onSequenceEnd.set(targetId, list);
    });
  }

  /** Plays hit → open → beam → absorb → close → drop → shakes → result. */
  async playSequence(m: ServerMessageOf<"CAPTURE_SEQUENCE">): Promise<void> {
    let b = this.balls.get(m.ballId);
    if (!b) {
      // Never saw the throw (arrived late): show the ball at the hit point
      const body = newBall(m.hit.x, m.hit.y, m.hit.z, 0, 0, 0);
      b = this.make(m.ballId, "", 0, m.ball, body);
    }
    const ball = b;
    ball.state = "sequence";
    ball.trail?.stop();
    ball.trail = null;
    const mine = ball.mine;
    this.busy.add(m.targetId);
    const entity = this.wild.get(m.targetId);
    const view = entity?.view;
    if (entity) entity.pinned = true;
    const pokeStart = view ? view.root.position.clone() : new Vector3(m.hit.x, m.hit.y, m.hit.z);
    const pokeCenter = () => (view ? view.root.position.add(new Vector3(0, view.height * 0.5, 0)) : pokeStart);
    const hit = new Vector3(m.hit.x, m.hit.y, m.hit.z);
    const rest = new Vector3(m.rest.x, m.rest.y, m.rest.z);
    const model = ball.model;
    const pos = model.root.position;
    // Ball faces the Pokémon while open
    const face = Math.atan2(pokeStart.x - hit.x, pokeStart.z - hit.z);

    const animate = (dur: number, fn: (k: number) => void) =>
      new Promise<void>((resolve) => {
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / (dur * 1000));
          fn(k);
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        step();
      });

    try {
      // Hit: impact, spark, little rebound
      this.sfx.play("ball_hit");
      this.fx.impactSpark(hit);
      if (mine) {
        this.cam.shake(0.25);
        this.sfx.vibrate(25);
      }
      model.spin.rotation.set(0, face, 0);
      await animate(0.15, (k) => pos.set(hit.x, hit.y + Math.sin(k * Math.PI) * 0.35 + k * 0.25, hit.z));
      const hover = pos.clone();
      // Open + bright capture light
      this.sfx.play("ball_open");
      await animate(0.15, (k) => {
        model.setOpen(k);
        this.fx.setLight(hover, 3 * k);
      });
      // Beam and absorb: energy form, pulled in, shrinking
      this.sfx.play("capture_beam");
      let lastEmit = 0;
      await animate(0.75, (k) => {
        const target = pokeCenter();
        this.fx.setBeam(hover, target, 1 - k * 0.5);
        if (view) {
          view.setEnergy(Math.min(1, k * 2));
          view.captureShrink = Math.pow(k, 1.6);
          view.root.position.copyFrom(Vector3.Lerp(pokeStart, hover.subtract(new Vector3(0, view.height * 0.3, 0)), Math.pow(k, 2)));
        }
        if (k - lastEmit > 0.12) {
          lastEmit = k;
          this.fx.captureEnergy(view ? view.root.position : pokeStart, Math.max(0.4, (view?.width ?? 1) * 0.6));
        }
      });
      this.fx.setBeam(null);
      if (entity) entity.held = true;
      view?.setVisible(false);
      // Close
      this.sfx.play("ball_close");
      await animate(0.15, (k) => {
        model.setOpen(1 - k);
        this.fx.setLight(hover, 3 * (1 - k));
      });
      this.fx.setLight(null, 0);
      // Drop to the ground (or water surface) under the hit point
      await animate(TIMING.drop - 0.05, (k) => {
        const y = hover.y + (rest.y - hover.y) * (k * k);
        pos.set(hover.x + (rest.x - hover.x) * k, y, hover.z + (rest.z - hover.z) * k);
      });
      pos.copyFrom(rest);
      this.sfx.play("ball_bounce");
      await animate(0.05, () => {});

      // Shakes
      if (m.critical) {
        this.sfx.play("capture_critical");
        this.fx.criticalFlash(rest);
        model.setGlow(1);
        await animate(TIMING.critical, (k) => {
          const s = Math.sin(k * Math.PI * 2) * (1 - k) * 0.9;
          model.spin.rotation.z = s;
          pos.y = rest.y + Math.abs(Math.sin(k * Math.PI)) * 0.18;
          model.setGlow(k < 0.5 ? 1 : 0.3);
        });
        pos.y = rest.y;
      } else {
        for (let i = 0; i < m.shakes; i++) {
          this.sfx.play("ball_shake");
          this.fx.shakeFlash(rest.add(new Vector3(0, BALL.radius, 0)));
          model.setGlow(1);
          if (mine) this.sfx.vibrate(15);
          await animate(0.55, (k) => {
            model.spin.rotation.z = Math.sin(k * Math.PI * 2) * 0.5 * (1 - k * 0.3);
            pos.x = rest.x + Math.sin(k * Math.PI * 2) * 0.04;
            model.setGlow(1 - k);
          });
          model.spin.rotation.z = 0;
          pos.x = rest.x;
          await wait(400);
        }
      }

      const name = this.host.speciesName(m.species);
      if (m.success) {
        // Click, stars, Gotcha!
        model.setGlow(0);
        this.sfx.play("capture_success");
        this.fx.starBurst(rest.add(new Vector3(0, 0.3, 0)));
        if (mine) {
          this.cam.shake(0.18);
          this.sfx.vibrate([40, 40, 90]);
          this.host.gotcha("Gotcha!", `${name} was caught!`);
        }
        await animate(TIMING.result, (k) => model.setGlow(k < 0.5 ? 0.6 : 0));
        await wait(500);
        await animate(0.3, (k) => model.root.scaling.setAll(1 - k));
      } else {
        // Breakout: the ball bursts open, the Pokémon reappears angry
        this.sfx.play("capture_breakout");
        this.fx.breakoutBurst(rest.add(new Vector3(0, 0.2, 0)));
        if (mine) {
          this.cam.shake(0.35);
          this.sfx.vibrate(70);
        }
        if (entity) entity.held = false;
        if (view) {
          view.setVisible(true);
          view.root.position.copyFrom(pokeStart);
        }
        await animate(0.35, (k) => {
          model.setOpen(Math.min(1, k * 3));
          model.root.scaling.setAll(1 - k);
          if (view) {
            view.captureShrink = 1 - k;
            view.setEnergy(1 - k);
          }
        });
        if (view) {
          view.captureShrink = 0;
          view.setEnergy(0);
          view.playRecoil();
        }
        if (mine) this.host.toast(m.shakes === 0 ? `앗! ${name}이(가) 바로 튀어나왔다!` : `아깝다! ${name}이(가) 볼에서 빠져나왔다!`, "bad");
      }
    } finally {
      this.fx.setBeam(null);
      this.fx.setLight(null, 0);
      if (entity && !m.success) {
        entity.pinned = false;
        entity.held = false;
      }
      this.remove(ball);
      this.busy.delete(m.targetId);
      for (const cb of this.onSequenceEnd.get(m.targetId) ?? []) cb();
      this.onSequenceEnd.delete(m.targetId);
    }
  }

  update(dt: number, player: Vector3): void {
    this.time += dt;
    this.fx.update(dt);
    for (const b of [...this.balls.values()]) {
      const pos = b.model.root.position;
      if (b.pickup) {
        b.pickup.t += dt * 3;
        const to = b.pickup.to();
        pos.copyFrom(Vector3.Lerp(pos, to, Math.min(1, b.pickup.t)));
        b.model.root.scaling.setAll(Math.max(0.2, 1 - b.pickup.t));
        if (b.pickup.t >= 1) this.remove(b);
        continue;
      }
      if (b.state === "flying") {
        const events = stepBall(this.world, b.body, dt);
        for (const e of events) {
          if (e.kind === "bounce" && e.speed > 2) this.sfx.play("ball_bounce");
          if (e.kind === "rest") this.settle(b);
        }
        pos.set(b.body.x, b.body.y, b.body.z);
        b.model.spin.rotation.x = b.body.rx;
        b.model.spin.rotation.z = b.body.rz;
        b.trail?.follow(pos);
        b.flySound -= dt;
        if (b.flySound <= 0 && Math.hypot(b.body.vx, b.body.vz) > 6) {
          b.flySound = 0.35;
          if (Vector3.Distance(pos, player) < 20) this.sfx.play("ball_fly");
        }
        if (b.mine) this.cam.assist = pos.clone();
      } else if (b.state === "resting") {
        if (b.restTarget) {
          pos.copyFrom(Vector3.Lerp(pos, b.restTarget, Math.min(1, dt * 8)));
          b.body.x = pos.x;
          b.body.y = pos.y;
          b.body.z = pos.z;
        }
        // Lying balls glow softly so they can be found again
        b.model.setGlow(b.mine ? 0.35 + Math.sin(this.time * 4) * 0.25 : 0.15);
      }
    }
  }

  clear(): void {
    for (const b of [...this.balls.values()]) this.remove(b);
    this.busy.clear();
  }
}
