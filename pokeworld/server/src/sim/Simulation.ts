import {
  BATTLE_START_RANGE,
  DAY_LENGTH_SECONDS,
  DESPAWN_DISTANCE,
  INTERACT_RANGE,
  INTEREST_RADIUS,
  MAX_PARTY,
  MOVE,
  PROTOCOL_VERSION,
  SAVE_VERSION,
  SPAWN_BUDGET_GLOBAL,
  SPAWN_BUDGET_PER_PLAYER,
  SPAWN_MAX_DISTANCE,
  TICK_RATE,
} from "@shared/config/constants";
import { BALL, type BallBody, newBall, segmentHitsBox, stepBall } from "@shared/capture/ballPhysics";
import { type CaptureContext, CaptureCalculator, type CaptureRoll } from "@shared/capture/CaptureCalculator";
import type { ContentDB } from "@shared/data/contentDb";
import { createCreature, creatureName, healCreature, maxHp, normalizeCreature } from "@shared/data/stats";
import { Rng, randomId } from "@shared/math/rng";
import { dist2 } from "@shared/math/vec";
import type { BallSnapshot, ClientMessage, CreatureMove, PlayerAction, RemotePlayerMove, ServerMessage } from "@shared/protocol/messages";
import type { BattleAction, BattleEvent, BattleKind, BattleOutcome } from "@shared/types/battle";
import type { InteractableDef, NpcDef, Weather } from "@shared/types/content";
import type { AnimState, CreatureInstance, WorldClock } from "@shared/types/game";
import { type PlayerSave, type WorldSave, migrateSave } from "@shared/types/save";
import { UNDERGROUND_BIOMES } from "@shared/world/blocks";
import { bodyBlocked, unstick } from "@shared/world/physics";
import { clockAt } from "@shared/world/time";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import { Battle } from "../battle/Battle";
import { type LegendaryBattleRequest, type LegendaryResult, LegendaryManager } from "../legendary/LegendaryManager";
import type { PlayerStore } from "../persistence/PlayerStore";
import { type Connection, Player } from "../player/Player";
import { aiInterval, startFlee, updateCreature } from "../pokemon/CreatureAI";
import { evolveIfReady } from "../pokemon/progression";
import { WildCreature } from "../pokemon/WildCreature";
import { type QuestChanges, QuestManager } from "../quest/QuestManager";
import { SpawnManager } from "../spawn/SpawnManager";
import { SpatialIndex } from "../world/SpatialIndex";
import { OVERWORLD, World } from "../world/World";

export interface SimulationOptions {
  db: ContentDB;
  store: PlayerStore;
  /** Multiplayer servers require tokens to resume a player; local play does not. */
  multiplayer: boolean;
  seed?: number;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  log?: (msg: string) => void;
  /** Share the client renderer's voxel store in single player (no duplicate generation). */
  voxels?: VoxelWorld;
}

interface BattleRecord {
  battle: Battle;
  player: Player;
  entity?: WildCreature;
  legendary?: LegendaryBattleRequest;
  trainerId?: string;
  /** A Poké Ball thrown this turn has not resolved yet. */
  ballInFlight?: string;
}

/** A Poké Ball in the world. */
interface ThrownBall {
  id: string;
  owner: string;
  seq: number;
  ball: string;
  body: BallBody;
  state: "flying" | "resting" | "capturing";
  battleId?: string;
  /** World time (s) after which a resting ball disappears. */
  expires: number;
  /** Players that have been told about this ball. */
  known: Set<string>;
}

interface PendingCapture {
  ball: ThrownBall;
  creature: WildCreature;
  player: Player;
  roll: CaptureRoll;
  at: number;
  battleId?: string;
}

/** Timeline of the capture presentation (s); clients play the same beats. */
export const CAPTURE_TIMING = { absorb: 1.2, drop: 0.55, shake: 0.95, critical: 0.7, result: 0.45 };

export function captureDuration(shakes: number, critical: boolean): number {
  const t = CAPTURE_TIMING;
  return t.absorb + t.drop + (critical ? t.critical : shakes * t.shake) + t.result;
}

const AUTOSAVE_SECONDS = 30;
const WORLD_SAVE_SECONDS = 60;
const MAX_MESSAGES_PER_SECOND = 80;
const MAX_BALLS_IN_FLIGHT = 3;
const THROW_COOLDOWN = 0.45;

const secureRandomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * The authoritative game simulation. Runs unchanged in two hosts:
 *  - Node (server/src/main.ts) behind WebSockets for multiplayer
 *  - the browser (client LocalGameServer) for single player
 * Clients only send requests; every outcome (movement, spawns, ball flight,
 * capture, damage, rewards, quests, inventory) is decided here.
 */
export class Simulation {
  readonly world: World;
  readonly db: ContentDB;
  readonly captures: CaptureCalculator;
  private readonly store: PlayerStore;
  private readonly rng: Rng;
  private readonly spawner: SpawnManager;
  private readonly quests: QuestManager;
  private readonly legend: LegendaryManager;
  private readonly nowMs: () => number;
  private readonly log: (msg: string) => void;

  private readonly players = new Map<string, Player>();
  private readonly creatures = new Map<string, WildCreature>();
  private readonly creatureIndex = new SpatialIndex<WildCreature>();
  private readonly playerIndex = new SpatialIndex<Player>();
  private readonly battles = new Map<string, BattleRecord>();
  private readonly balls = new Map<string, ThrownBall>();
  private readonly pending: PendingCapture[] = [];
  /** Time wheel: tick -> creatures due for an AI update. */
  private readonly wheel = new Map<number, WildCreature[]>();
  private readonly lastAiTick = new Map<string, number>();

  private tickCount = 0;
  private worldTime = 0;
  private weather: Weather = "clear";
  private nextWeatherChange = 300;
  private lastPeriod = "";
  private lastWeatherSent: Weather = "clear";
  private nextClockBroadcast = 0;
  private nextWorldSave = WORLD_SAVE_SECONDS;
  private claimedLegendaries: string[] = [];
  /** Test hook: forces the next capture roll (local single player only). */
  private forcedCapture: "success" | "fail" | "critical" | null = null;

  constructor(private readonly opts: SimulationOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.world = new World(opts.db, opts.voxels);
    this.rng = new Rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.spawner = new SpawnManager(opts.db, this.world);
    this.quests = new QuestManager(opts.db);
    this.legend = new LegendaryManager(opts.db);
    this.nowMs = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    if (!opts.db.capture) throw new Error("content has no capture config");
    this.captures = new CaptureCalculator(opts.db.capture, opts.db.balls);
  }

  private get now(): number {
    return this.nowMs() / 1000;
  }

  async init(): Promise<void> {
    const w = await this.store.loadWorld();
    if (w) {
      this.worldTime = w.time;
      this.weather = (w.weather as Weather) ?? "clear";
      this.claimedLegendaries = w.claimedLegendaries ?? [];
    }
  }

  clock(): WorldClock {
    return clockAt(this.worldTime, this.weather);
  }

  /** 0..1 how much sunlight reaches open ground now. */
  private daylight(): number {
    const p = this.clock().period;
    return p === "night" ? 0.25 : p === "dawn" || p === "dusk" ? 0.6 : 1;
  }

  get playerCount(): number {
    return this.players.size;
  }

  get creatureCount(): number {
    return this.creatures.size;
  }

  // ---------------------------------------------------------------- sessions

  async join(conn: Connection, hello: Extract<ClientMessage, { type: "HELLO" }>): Promise<Player | null> {
    if (hello.protocol !== PROTOCOL_VERSION) {
      conn.send({ type: "ERROR", code: "protocol", message: `서버 버전(${PROTOCOL_VERSION})과 맞지 않습니다. 새로고침해 주세요.` });
      return null;
    }
    const name = (hello.name ?? "").trim().slice(0, 16) || "트레이너";

    let save: PlayerSave | null = null;
    let token = hello.token ?? "";
    let id = hello.playerId ?? "";

    if (this.opts.multiplayer) {
      if (id && token && (await this.store.checkToken(id, token))) save = await this.loadSave(id);
      if (!save) {
        id = `p_${secureRandomHex(8)}`;
        token = secureRandomHex(24);
        await this.store.setToken(id, token);
      }
    } else {
      id = id || "local";
      save = await this.loadSave(id);
    }

    // A second connection for the same player replaces the first
    const existing = this.players.get(id);
    if (existing) {
      existing.send({ type: "ERROR", code: "replaced", message: "다른 곳에서 접속하여 연결이 종료되었습니다." });
      await this.leave(id);
    }

    if (!save) save = this.newSave(id, name);
    this.repairSave(save);

    const p = new Player(save, conn, this.now);
    p.nextSpawnCheck = this.now + 1;
    this.players.set(id, p);
    this.playerIndex.upsert(p);

    const qc = this.quests.refresh(p);

    p.send({
      type: "WELCOME",
      playerId: id,
      token,
      protocol: PROTOCOL_VERSION,
      region: this.world.region.id,
      self: p.snapshot(this.db),
      state: p.privateState(),
      clock: this.clock(),
      multiplayer: this.opts.multiplayer,
    });
    this.notify(p, qc);
    this.log(`join ${id} (${name}) players=${this.players.size}`);
    await this.persist(p);
    return p;
  }

  /** Fixes up a loaded save for the current content and world. */
  private repairSave(save: PlayerSave): void {
    save.party = save.party.filter((c) => normalizeCreature(this.db, c, this.rng));
    save.box = save.box.filter((c) => normalizeCreature(this.db, c, this.rng));
    for (const id of Object.keys(save.inventory)) if (!this.db.items.has(id)) delete save.inventory[id];
    save.seen = save.seen.filter((s) => this.db.species.has(s));
    save.caught = save.caught.filter((s) => this.db.species.has(s));
    if (save.respawn || !this.world.hasZone(save.zone) || !Number.isFinite(save.y)) {
      const r = this.world.region;
      save.zone = OVERWORLD;
      save.x = r.spawn.x + 0.5;
      save.z = r.spawn.z + 0.5;
      save.y = this.world.surfaceFeet(save.x, save.z);
      delete save.respawn;
    }
    // Never start inside blocks
    const body = { x: save.x, y: save.y, z: save.z, halfW: MOVE.radius, height: MOVE.height };
    unstick(this.world.voxels, body);
    save.y = body.y;
  }

  private async loadSave(id: string): Promise<PlayerSave | null> {
    const raw = await this.store.loadPlayer(id);
    if (!raw) return null;
    try {
      return migrateSave(raw);
    } catch (e) {
      this.log(`save for ${id} unusable: ${(e as Error).message}`);
      return null;
    }
  }

  private newSave(id: string, name: string): PlayerSave {
    const r = this.world.region;
    const now = Date.now();
    return {
      version: SAVE_VERSION,
      id,
      name,
      zone: OVERWORLD,
      x: r.spawn.x + 0.5,
      y: this.world.surfaceFeet(r.spawn.x + 0.5, r.spawn.z + 0.5),
      z: r.spawn.z + 0.5,
      rotY: 0,
      party: [],
      box: [],
      inventory: {},
      money: r.startingMoney,
      flags: { starterChosen: false, trainersDefeated: [], collected: [], visited: [] },
      quests: { active: {}, completed: [] },
      legendary: { nodes: {}, completed: [] },
      seen: [],
      caught: [],
      playTime: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async leave(id: string): Promise<void> {
    const p = this.players.get(id);
    if (!p) return;
    if (p.battle) {
      const rec = this.battles.get(p.battle.id);
      if (rec) this.abortBattle(rec);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pc = this.pending[i];
      if (pc.player !== p) continue;
      this.pending.splice(i, 1);
      pc.creature.state = "idle";
      pc.creature.dirty = true;
      this.removeBall(pc.ball);
    }
    // Balls in flight are lost; balls on the ground stay for a while
    for (const b of [...this.balls.values()]) if (b.owner === id && b.state !== "resting") this.removeBall(b);
    this.players.delete(id);
    this.playerIndex.remove(p);
    for (const other of this.players.values()) {
      if (other.knownPlayers.delete(id)) other.send({ type: "PLAYER_LEAVE", id });
    }
    for (const c of [...this.creatures.values()]) if (c.owner === id) this.removeCreature(c, "despawn");
    await this.persist(p);
    this.log(`leave ${id} players=${this.players.size}`);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.players.values()].map((p) => this.persist(p)));
    await this.saveWorld();
  }

  async saveNow(id: string): Promise<boolean> {
    const p = this.players.get(id);
    if (!p) return false;
    await this.persist(p);
    return true;
  }

  private async persist(p: Player): Promise<void> {
    const now = this.now;
    p.save.playTime += Math.max(0, now - Math.max(p.sessionStart, p.lastSavedAt || p.sessionStart));
    p.lastSavedAt = now;
    p.save.updatedAt = Date.now();
    p.dirty = false;
    try {
      await this.store.savePlayer(p.save);
    } catch (e) {
      this.log(`save failed for ${p.id}: ${(e as Error).message}`);
    }
  }

  private async saveWorld(): Promise<void> {
    const w: WorldSave = { version: 1, time: this.worldTime, weather: this.weather, claimedLegendaries: this.claimedLegendaries };
    try {
      await this.store.saveWorld(w);
    } catch (e) {
      this.log(`world save failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- messages

  handle(playerId: string, msg: ClientMessage): void {
    const p = this.players.get(playerId);
    if (!p) return;

    const now = this.now;
    if (now - p.msgWindowStart >= 1) {
      p.msgWindowStart = now;
      p.msgCount = 0;
    }
    if (++p.msgCount > MAX_MESSAGES_PER_SECOND) return;

    try {
      switch (msg.type) {
        case "PLAYER_MOVE":
          return this.onMove(p, msg);
        case "PLAYER_ROTATE":
          if (!p.battle) {
            p.save.rotY = msg.rotY;
            p.moved = true;
          }
          return;
        case "PLAYER_ACTION":
          return this.onAction(p, msg.action);
        case "BATTLE_ACTION":
          return this.onBattleAction(p, msg.battleId, msg.action);
        case "BALL_THROW":
          return this.onBallThrow(p, msg);
        case "PING":
          return p.send({ type: "PONG", t: msg.t, serverTime: this.nowMs() });
        case "HELLO":
          return;
      }
    } catch (e) {
      this.log(`error handling ${msg.type} from ${playerId}: ${(e as Error).stack ?? e}`);
      p.send({ type: "ERROR", code: "internal", message: "요청을 처리하지 못했습니다." });
    }
  }

  private onMove(p: Player, m: Extract<ClientMessage, { type: "PLAYER_MOVE" }>): void {
    if (p.battle) return;
    if (m.seq <= p.lastSeq) return;
    p.lastSeq = m.seq;

    const now = this.now;
    const dt = Math.max(0.05, now - p.lastMoveAt);
    const mount = p.mounted ? this.db.species.get(p.mounted)?.mount : undefined;
    const flying = !!mount?.modes.includes("fly");
    const maxSpeed = mount ? (flying ? MOVE.fly : MOVE.run) * mount.speed : MOVE.run;
    const allowed = maxSpeed * 1.5 * dt + 2;
    const s = p.save;
    const moved = dist2(s.x, s.z, m.x, m.z);
    const vox = this.world.voxels;
    // A slightly shrunken body tolerates rounding at block edges
    const inside = bodyBlocked(vox, { x: m.x, y: m.y + 0.25, z: m.z, halfW: MOVE.radius * 0.6, height: MOVE.height - 0.5 });
    const swimming = this.world.inWater(m.x, m.y + 0.5, m.z) || this.world.inWater(m.x, m.y - 0.3, m.z);
    // Rising faster than a jump without wings or water is not allowed
    const rose = m.y - s.y;
    const tooHigh = !flying && !swimming && rose > 2.2 + 12 * dt;
    const fell = m.y < -4;

    if (moved > allowed || inside || tooHigh || fell) {
      if (fell) s.y = this.world.surfaceFeet(s.x, s.z);
      p.send({ type: "PLAYER_CORRECT", zone: s.zone, x: s.x, y: s.y, z: s.z, reason: "movement" });
      p.lastMoveAt = now;
      return;
    }

    s.x = m.x;
    s.y = m.y;
    s.z = m.z;
    s.rotY = m.rotY;
    p.anim = m.anim;
    p.lastMoveAt = now;
    p.moved = true;
    this.playerIndex.upsert(p);

    if (now - p.lastAreaCheck > 0.5) {
      p.lastAreaCheck = now;
      this.checkAreas(p);
    }
  }

  private checkAreas(p: Player): void {
    for (const area of this.world.areasAt(p.x, p.y, p.z)) {
      if (p.save.flags.visited.includes(area.id)) continue;
      p.save.flags.visited.push(area.id);
      p.dirty = true;
      p.send({ type: "TOAST", text: `📍 ${area.name}`, tone: "info" });
      const qc = this.quests.handle(p, { kind: "visit", area: area.id });
      const lr = this.legend.onVisit(p, area.id);
      this.notify(p, qc, lr);
    }
  }

  private onAction(p: Player, a: PlayerAction): void {
    switch (a.kind) {
      case "interact":
        return this.interact(p, a.target);
      case "battle": {
        const c = this.creatures.get(a.target);
        if (!c) return p.send({ type: "TOAST", text: "대상이 사라졌다.", tone: "bad" });
        return this.requestWildBattle(p, c);
      }
      case "choose_starter":
        return this.chooseStarter(p, a.species);
      case "buy":
        return this.buy(p, a.item, a.count);
      case "use_item":
        return this.useItem(p, a.item, a.partyIndex);
      case "party_swap": {
        const party = p.save.party;
        if (p.battle) return;
        if (!party[a.a] || !party[a.b] || a.a === a.b) return;
        [party[a.a], party[a.b]] = [party[a.b], party[a.a]];
        p.dirty = true;
        p.moved = true;
        return this.sendState(p);
      }
      case "mount":
        return this.setMount(p, a.on);
      case "save":
        void this.persist(p).then(() => p.send({ type: "TOAST", text: "게임을 저장했습니다.", tone: "good" }));
        return;
    }
  }

  // ---------------------------------------------------------------- interaction

  private near(p: Player, o: { x: number; z: number; y?: number }, range = INTERACT_RANGE + 1.5): boolean {
    const y = this.world.objectY(o);
    return dist2(p.x, p.z, o.x, o.z) <= range && Math.abs(p.y - y) < 6;
  }

  private interact(p: Player, target: string): void {
    if (p.battle) return;
    const npc = this.world.npc(target);
    if (npc) {
      if (!this.near(p, npc)) return p.send({ type: "TOAST", text: "너무 멀다.", tone: "bad" });
      return this.talkTo(p, npc);
    }
    const obj = this.world.interactable(target);
    if (obj) {
      if (!this.near(p, obj, INTERACT_RANGE + 2.5)) return p.send({ type: "TOAST", text: "너무 멀다.", tone: "bad" });
      return this.useObject(p, obj);
    }
    const c = this.creatures.get(target);
    if (c) return this.requestWildBattle(p, c);
  }

  private talkTo(p: Player, npc: NpcDef): void {
    const lr = this.legend.onTalk(p, npc.id);
    const qc = this.quests.handle(p, { kind: "talk", npc: npc.id });

    switch (npc.role) {
      case "professor":
        if (!p.save.flags.starterChosen) {
          p.send({
            type: "DIALOG",
            speaker: npc.name,
            lines: [npc.dialogue[0], "여행을 떠나려면 파트너 포켓몬이 필요해. 셋 중 하나를 골라 보렴!"],
            choice: { kind: "starter", options: this.world.region.starters },
          });
        } else {
          p.send({ type: "DIALOG", speaker: npc.name, lines: npc.dialogue.slice(1) });
        }
        break;
      case "nurse":
        for (const c of p.save.party) healCreature(this.db, c);
        p.dirty = true;
        p.send({ type: "DIALOG", speaker: npc.name, lines: [npc.dialogue[0], "포켓몬들이 모두 건강해졌어요! 또 오세요."] });
        this.sendState(p);
        break;
      case "clerk":
        p.send({
          type: "DIALOG",
          speaker: npc.name,
          lines: npc.dialogue,
          choice: { kind: "shop", items: (npc.shop ?? []).map((id) => ({ id, price: this.db.items.get(id)?.price ?? 0 })) },
        });
        break;
      case "trainer": {
        const t = npc.trainer ? this.db.trainers.get(npc.trainer) : undefined;
        if (!t) break;
        if (p.save.flags.trainersDefeated.includes(t.id)) {
          p.send({ type: "DIALOG", speaker: npc.name, lines: [t.dialogue.after] });
        } else if (!p.save.party.some((c) => c.hp > 0)) {
          p.send({ type: "DIALOG", speaker: npc.name, lines: ["싸울 수 있는 포켓몬이 없잖아? 회복하고 다시 와!"] });
        } else {
          p.send({ type: "DIALOG", speaker: npc.name, lines: [t.dialogue.before] });
          this.startBattle(p, "trainer", t.team.map((m) => createCreature(this.db, m.species, m.level, this.rng)), { trainerId: t.id });
        }
        break;
      }
      default:
        p.send({ type: "DIALOG", speaker: npc.name, lines: npc.dialogue });
    }
    this.notify(p, qc, lr);
  }

  private useObject(p: Player, obj: InteractableDef): void {
    switch (obj.kind) {
      case "sign":
        return p.send({ type: "DIALOG", speaker: obj.name, lines: obj.text ?? [] });
      case "crystal": {
        if (!obj.item) return;
        if (p.save.flags.collected.includes(obj.id)) {
          return p.send({ type: "DIALOG", speaker: obj.name, lines: ["이미 조각을 챙겼다. 수정이 희미하게 빛나고 있다."] });
        }
        p.save.flags.collected.push(obj.id);
        p.add(obj.item.id, obj.item.count);
        p.send({ type: "DIALOG", speaker: obj.name, lines: obj.text ?? [] });
        const item = this.db.items.get(obj.item.id);
        p.send({ type: "TOAST", text: `${item?.name ?? obj.item.id}을(를) 얻었다!`, tone: "good" });
        this.notify(p, this.quests.handle(p, { kind: "inventory" }), this.legend.onInventory(p));
        return this.sendState(p);
      }
      case "tablet":
      case "altar": {
        const lr = this.legend.onInteract(p, obj.id, this.clock());
        const lines = lr.handled ? lr.lines : [...(obj.text ?? []), ...lr.lines];
        p.send({ type: "DIALOG", speaker: obj.name, lines });
        this.notify(p, undefined, lr);
        if (lr.battle) this.startLegendaryBattle(p, obj, lr.battle);
        if (lr.progressed.length > 0) this.sendState(p);
        return;
      }
    }
  }

  private chooseStarter(p: Player, species: string): void {
    if (p.save.flags.starterChosen) return;
    if (!this.world.region.starters.includes(species)) return;
    const prof = this.world.region.npcs.find((n) => n.role === "professor");
    if (prof && !this.near(p, prof, 8)) return;

    const c = createCreature(this.db, species, 5, this.rng);
    c.caughtAt = Date.now();
    c.ball = "poke_ball";
    c.origin = "레아 연구소";
    p.save.party.push(c);
    p.save.flags.starterChosen = true;
    this.markSeen(p, species, true);
    p.add("poke_ball", 10);
    p.dirty = true;

    const name = this.db.species.get(species)!.name;
    p.send({
      type: "DIALOG",
      speaker: prof?.name ?? "박사",
      lines: [`${name}(을)를 골랐구나! 잘 부탁해.`, "몬스터볼 10개도 챙겨 가렴. 볼을 손에 들고 조준해서 던지면 돼. 약해진 포켓몬일수록 잘 잡힌단다!"],
    });
    p.send({ type: "TOAST", text: `${name}이(가) 파트너가 되었다!`, tone: "good" });
    this.notify(p, this.quests.handle(p, { kind: "obtain_partner" }));
    p.moved = true;
    this.sendState(p);
    void this.persist(p);
  }

  private buy(p: Player, itemId: string, count: number): void {
    const item = this.db.items.get(itemId);
    if (!item?.price || !Number.isInteger(count) || count < 1 || count > 99) return;
    const seller = this.world.region.npcs.find((n) => n.shop?.includes(itemId) && this.near(p, n, INTERACT_RANGE + 4));
    if (!seller) return p.send({ type: "TOAST", text: "상점 근처에서만 살 수 있다.", tone: "bad" });
    const cost = item.price * count;
    if (p.save.money < cost) return p.send({ type: "TOAST", text: "돈이 부족하다.", tone: "bad" });
    p.save.money -= cost;
    p.add(itemId, count);
    p.send({ type: "TOAST", text: `${item.nameKo ?? item.name} ×${count} 구입 (-${cost}원)`, tone: "good" });
    this.sendState(p);
  }

  private useItem(p: Player, itemId: string, index: number): void {
    if (p.battle) return;
    const item = this.db.items.get(itemId);
    const c = p.save.party[index];
    if (!item || item.kind !== "heal" || !c) return;
    const max = maxHp(this.db, c);
    if (c.hp <= 0) return p.send({ type: "TOAST", text: "기절한 포켓몬에게는 쓸 수 없다. 포켓몬 센터에 가자.", tone: "bad" });
    if (item.cureStatus) {
      if (!c.status) return p.send({ type: "TOAST", text: "상태이상이 없다.", tone: "bad" });
      if (!p.consume(itemId)) return;
      delete c.status;
      delete c.statusTurns;
      p.send({ type: "TOAST", text: `${creatureName(this.db, c)}의 상태이상이 나았다.`, tone: "good" });
      return this.sendState(p);
    }
    if (c.hp >= max) return p.send({ type: "TOAST", text: "HP가 이미 가득 차 있다.", tone: "bad" });
    if (!p.consume(itemId)) return;
    const amount = Math.min(item.heal ?? 0, max - c.hp);
    c.hp += amount;
    p.send({ type: "TOAST", text: `${creatureName(this.db, c)}의 HP가 ${amount} 회복되었다.`, tone: "good" });
    this.sendState(p);
  }

  private setMount(p: Player, on: boolean): void {
    if (p.battle) return;
    if (!on) {
      if (p.mounted) {
        p.mounted = null;
        p.moved = true;
        this.sendState(p);
      }
      return;
    }
    const lead = p.save.party.find((c) => c.hp > 0 && this.db.speciesOf(c).mount);
    if (!lead) {
      return p.send({ type: "TOAST", text: "탈 수 있는 포켓몬이 파티에 없다. (포니타·켄타로스·라프라스·고래왕자·갸라도스·피죤투·리자몽·망나뇽 등)", tone: "bad" });
    }
    p.mounted = lead.species;
    p.moved = true;
    const modes = this.db.speciesOf(lead).mount!.modes;
    const how = modes.includes("fly") ? "하늘을 날 수 있다" : modes.includes("swim") ? "물 위를 달릴 수 있다" : "빠르게 달릴 수 있다";
    p.send({ type: "TOAST", text: `${creatureName(this.db, lead)}에 탔다! ${how}.`, tone: "good" });
    this.sendState(p);
  }

  private teleport(p: Player, x: number, z: number, rotY: number, y?: number): void {
    const s = p.save;
    s.zone = OVERWORLD;
    s.x = x;
    s.z = z;
    s.y = y ?? this.world.surfaceFeet(x, z);
    const body = { x, y: s.y, z, halfW: MOVE.radius, height: MOVE.height };
    unstick(this.world.voxels, body);
    s.y = body.y;
    s.rotY = rotY;
    this.playerIndex.upsert(p);
    p.moved = true;
    p.dirty = true;
    p.send({ type: "PLAYER_CORRECT", zone: OVERWORLD, x, y: s.y, z, rotY, reason: "teleport" });
    p.lastMoveAt = this.now;
    this.checkAreas(p);
  }

  // ---------------------------------------------------------------- battles

  private healthy(p: Player): boolean {
    return p.save.party.some((c) => c.hp > 0);
  }

  private requestWildBattle(p: Player, c: WildCreature): void {
    if (p.battle || c.state === "battle" || c.state === "capturing" || c.special) return;
    if (dist2(p.x, p.z, c.x, c.z) > BATTLE_START_RANGE + 1 + c.width / 2 || Math.abs(p.y - c.y) > 6) {
      return p.send({ type: "TOAST", text: "조금 더 가까이 가야 한다.", tone: "bad" });
    }
    if (!this.healthy(p)) {
      const msg = p.save.party.length === 0 ? "파트너가 없다! 마을 북쪽 연구소의 레아 박사를 찾아가자." : "싸울 수 있는 포켓몬이 없다. 포켓몬 센터로 가자.";
      return p.send({ type: "TOAST", text: msg, tone: "bad" });
    }
    this.startBattle(p, "wild", [c.creature], { entity: c });
  }

  private startBattle(
    p: Player,
    kind: BattleKind,
    foes: CreatureInstance[],
    extra: { entity?: WildCreature; trainerId?: string; legendary?: LegendaryBattleRequest } = {},
  ): void {
    if (p.mounted) p.mounted = null;
    const trainer = extra.trainerId ? this.db.trainers.get(extra.trainerId) : undefined;
    const battle = new Battle(this.db, this.rng, {
      id: randomId("b_", this.rng),
      kind,
      playerId: p.id,
      party: p.save.party,
      foes,
      trainer,
      entityId: extra.entity?.id,
      canCapture: (kind === "wild" || kind === "legendary") && !!extra.entity,
      canRun: kind === "wild" || kind === "legendary",
    });
    const rec: BattleRecord = { battle, player: p, entity: extra.entity, legendary: extra.legendary, trainerId: extra.trainerId };
    this.battles.set(battle.id, rec);
    p.battle = battle;
    p.moved = true;
    if (extra.entity) {
      extra.entity.state = "battle";
      extra.entity.anim = "battle";
      extra.entity.rotY = Math.atan2(p.x - extra.entity.x, p.z - extra.entity.z);
      extra.entity.dirty = true;
    }
    for (const f of foes) this.markSeen(p, f.species, false);
    p.send({ type: "BATTLE_START", battle: battle.view() });
  }

  private startLegendaryBattle(p: Player, obj: InteractableDef, req: LegendaryBattleRequest): void {
    if (!this.healthy(p)) {
      p.send({ type: "DIALOG", speaker: obj.name, lines: ["…기운이 다시 가라앉았다. 포켓몬을 회복하고 다시 오자."] });
      return;
    }
    const away = Math.atan2(p.x - obj.x, p.z - obj.z);
    const x = obj.x + Math.sin(away) * 4;
    const z = obj.z + Math.cos(away) * 4;
    const creature = createCreature(this.db, req.species, req.level, this.rng);
    creature.origin = this.world.region.ruins.find((r) => Math.hypot(r.x - obj.x, r.z - obj.z) < r.radius + 4)?.name;
    const species = this.db.species.get(req.species)!;
    const fly = species.movement.air && !species.movement.land;
    const ground = this.world.floorNear(x, p.y + 2, z, Math.ceil(species.hitbox.height), 3, 10) ?? p.y;
    const entity = new WildCreature(
      randomId("w_", this.rng),
      creature,
      species,
      OVERWORLD,
      x,
      ground + (fly ? 2 : 0),
      z,
      away + Math.PI,
      fly ? "fly" : "walk",
      { x, y: ground, z },
      this.now,
      undefined,
      req.kind === "guardian" ? "guardian" : "legendary",
      p.id,
    );
    this.addCreature(entity);
    this.startBattle(p, req.kind === "guardian" ? "guardian" : "legendary", [creature], { entity, legendary: req });
    p.send({ type: "WORLD_EVENT", event: { kind: "legendary", text: req.kind === "guardian" ? "유적의 수호자가 깨어났다!" : "무지개빛이 유적을 가득 채운다…!" } });
  }

  private onBattleAction(p: Player, battleId: string, action: BattleAction): void {
    const rec = this.battles.get(battleId);
    if (!rec || rec.player !== p) return;
    if (rec.ballInFlight) return p.send({ type: "TOAST", text: "던진 볼의 결과를 기다리는 중이다.", tone: "bad" });
    const result = rec.battle.act(action, { count: (i) => p.count(i), consume: (i) => p.consume(i) });
    if ("error" in result) return p.send({ type: "TOAST", text: battleErrorText(result.error), tone: "bad" });

    p.dirty = true;
    const events = result.events;
    if (result.outcome) events.push(...this.finishBattle(rec, result.outcome, result.captured));
    p.send({ type: "BATTLE_RESULT", battle: rec.battle.view(), events, outcome: result.outcome });
    if (result.outcome) this.sendState(p);
  }

  /** Applies rewards/penalties when a battle ends. Returns extra events (evolutions, money). */
  private finishBattle(rec: BattleRecord, outcome: BattleOutcome, captured?: CreatureInstance): BattleEvent[] {
    const p = rec.player;
    const events: BattleEvent[] = [];
    this.battles.delete(rec.battle.id);
    p.battle = null;
    p.moved = true;
    let qc: QuestChanges | undefined;
    let lr: LegendaryResult | undefined;

    switch (outcome) {
      case "win": {
        qc = this.quests.handle(p, { kind: "win_battle" });
        if (rec.trainerId) {
          const t = this.db.trainers.get(rec.trainerId)!;
          p.save.money += t.reward;
          if (!p.save.flags.trainersDefeated.includes(t.id)) p.save.flags.trainersDefeated.push(t.id);
          const more = this.quests.handle(p, { kind: "defeat_trainer", trainer: t.id });
          qc = mergeChanges(qc, more);
        } else if (rec.battle.setup.kind === "wild") {
          const coins = 20 + rec.battle.foe.level * 6;
          p.save.money += coins;
          events.push({ t: "money", amount: coins });
        }
        if (rec.legendary?.kind === "guardian") lr = this.legend.onBattleResolved(p, rec.legendary, true);
        if (rec.legendary?.kind === "legendary") {
          events.push({ t: "text", text: "전설의 포켓몬은 무지개빛 속으로 사라졌다… 제단을 다시 조사하면 또 만날 수 있을 것 같다." });
        }
        if (rec.entity) this.removeCreature(rec.entity, "defeated");
        break;
      }
      case "capture": {
        if (captured) {
          qc = this.quests.handle(p, { kind: "catch", species: captured.species });
          if (rec.legendary) {
            lr = this.legend.onBattleResolved(p, rec.legendary, true);
            if (!this.claimedLegendaries.includes(`${p.id}:${rec.legendary.eventId}`)) this.claimedLegendaries.push(`${p.id}:${rec.legendary.eventId}`);
          }
        }
        if (rec.entity) this.removeCreature(rec.entity, "captured");
        break;
      }
      case "run":
        if (rec.entity) {
          if (rec.entity.special) this.removeCreature(rec.entity, "fled");
          else this.releaseCreature(rec.entity);
        }
        break;
      case "lose": {
        const lost = Math.floor(p.save.money * 0.1);
        p.save.money -= lost;
        for (const c of p.save.party) healCreature(this.db, c);
        events.push({ t: "text", text: `눈앞이 캄캄해졌다… ${lost}원을 잃고 포켓몬 센터로 돌아왔다.` });
        if (rec.entity) {
          if (rec.entity.special) this.removeCreature(rec.entity, "fled");
          else this.releaseCreature(rec.entity);
        }
        const r = this.world.region.respawn;
        this.teleport(p, r.x + 0.5, r.z + 0.5, Math.PI);
        break;
      }
    }

    if (outcome !== "lose") {
      for (const c of p.save.party) {
        const evo = evolveIfReady(this.db, c);
        if (evo) {
          events.push(evo);
          this.markSeen(p, c.species, true);
        }
      }
    }
    this.notify(p, qc, lr);
    return events;
  }

  /** Ends a battle without rewards (disconnect). */
  private abortBattle(rec: BattleRecord): void {
    this.battles.delete(rec.battle.id);
    rec.player.battle = null;
    if (rec.entity) {
      if (rec.entity.special) this.removeCreature(rec.entity, "despawn");
      else this.releaseCreature(rec.entity);
    }
  }

  private releaseCreature(c: WildCreature): void {
    c.state = "idle";
    c.stateUntil = this.now + 3;
    c.alertUntil = this.now + 15;
    c.dirty = true;
  }

  private receiveCreature(p: Player, c: CreatureInstance): "party" | "box" {
    c.caughtAt = Date.now();
    this.markSeen(p, c.species, true);
    p.dirty = true;
    if (p.save.party.length < MAX_PARTY) {
      p.save.party.push(c);
      return "party";
    }
    p.save.box.push(c);
    return "box";
  }

  private markSeen(p: Player, species: string, caught: boolean): void {
    if (!p.save.seen.includes(species)) p.save.seen.push(species);
    if (caught && !p.save.caught.includes(species)) p.save.caught.push(species);
  }

  // ---------------------------------------------------------------- Poké Balls

  private ballSnapshot(b: ThrownBall): BallSnapshot {
    const body = b.body;
    return { id: b.id, owner: b.owner, seq: b.seq, ball: b.ball, x: body.x, y: body.y, z: body.z, vx: body.vx, vy: body.vy, vz: body.vz, t: body.t, resting: body.resting };
  }

  private playersNear(x: number, z: number, radius = INTEREST_RADIUS): Player[] {
    return this.playerIndex.query(OVERWORLD, x, z, radius);
  }

  private onBallThrow(p: Player, m: Extract<ClientMessage, { type: "BALL_THROW" }>): void {
    const item = this.db.items.get(m.ball);
    const reject = (text: string) => {
      p.send({ type: "TOAST", text, tone: "bad" });
      // Tell the thrower its predicted ball never existed
      p.send({ type: "BALL_UPDATE", id: `seq:${m.seq}`, kind: "remove", x: m.x, y: m.y, z: m.z });
    };
    if (!item || item.kind !== "capture") return reject("던질 수 없는 아이템이다.");
    const now = this.now;
    if (now - p.lastThrowAt < THROW_COOLDOWN) return reject("너무 빨리 던졌다.");
    let flying = 0;
    for (const b of this.balls.values()) if (b.owner === p.id && b.state !== "resting") flying++;
    if (flying >= MAX_BALLS_IN_FLIGHT) return reject("던진 볼이 너무 많다.");
    let battleId: string | undefined;
    if (p.battle) {
      const rec = this.battles.get(p.battle.id);
      if (!rec || !rec.battle.setup.canCapture || !rec.entity) return reject("이 배틀에서는 포획할 수 없다!");
      if (rec.ballInFlight || rec.battle.awaiting !== "action") return reject("지금은 던질 수 없다.");
      battleId = rec.battle.id;
    }
    // The ball must leave from the player's hand
    const ex = p.x;
    const ey = p.y + 1.45;
    const ez = p.z;
    if (Math.hypot(m.x - ex, m.y - ey, m.z - ez) > 2.6) return reject("볼을 던질 수 없는 위치다.");
    const speed = Math.hypot(m.vx, m.vy, m.vz);
    if (!(speed <= BALL.maxThrowSpeed * 1.05)) return reject("너무 세게 던졌다.");
    if (!p.consume(item.id)) return reject(`${item.nameKo ?? item.name}이(가) 없다. 상점에서 살 수 있다.`);

    p.lastThrowAt = now;
    const ball: ThrownBall = {
      id: randomId("ball_", this.rng),
      owner: p.id,
      seq: m.seq,
      ball: item.id,
      body: newBall(m.x, m.y, m.z, m.vx, m.vy, m.vz),
      state: "flying",
      battleId,
      expires: Infinity,
      known: new Set(),
    };
    this.balls.set(ball.id, ball);
    if (battleId) this.battles.get(battleId)!.ballInFlight = ball.id;
    const snap = this.ballSnapshot(ball);
    for (const o of this.playersNear(ball.body.x, ball.body.z)) {
      ball.known.add(o.id);
      o.send({ type: "BALL_SPAWN", ball: snap });
    }
    this.sendState(p);
  }

  private stepBalls(dt: number): void {
    const now = this.now;
    for (const ball of [...this.balls.values()]) {
      if (ball.state === "capturing") continue;
      if (ball.state === "resting") {
        if (now > ball.expires) this.removeBall(ball);
        continue;
      }
      let hit: WildCreature | null = null;
      const events = stepBall(this.world.voxels, ball.body, dt, (px, py, pz) => {
        const b = ball.body;
        if (Math.hypot(b.vx, b.vy, b.vz) < 2.2 && b.bounces > 0) return false;
        for (const c of this.creatureIndex.query(OVERWORLD, b.x, b.z, 8)) {
          const hw = c.width / 2;
          if (segmentHitsBox(px, py, pz, b.x, b.y, b.z, c.x - hw, c.y, c.z - hw, c.x + hw, c.y + c.height, c.z + hw)) {
            hit = c;
            return true;
          }
        }
        return false;
      });
      if (hit) {
        this.onBallHit(ball, hit);
        continue;
      }
      for (const e of events) if (e.kind === "rest") this.onBallRest(ball);
      if (ball.body.t > 20 && ball.state === "flying") this.onBallRest(ball);
    }
  }

  private onBallRest(ball: ThrownBall): void {
    if (ball.state === "resting") return;
    ball.state = "resting";
    ball.body.resting = true;
    ball.expires = this.now + BALL.groundLifetime;
    const b = ball.body;
    for (const o of this.playersNear(b.x, b.z)) if (ball.known.has(o.id)) o.send({ type: "BALL_UPDATE", id: ball.id, kind: "rest", x: b.x, y: b.y, z: b.z });
    // A miss in battle still uses the turn
    if (ball.battleId) {
      const rec = this.battles.get(ball.battleId);
      ball.battleId = undefined;
      if (rec && rec.ballInFlight === ball.id) {
        rec.ballInFlight = undefined;
        this.resolveBattleCapture(rec, false, true);
      }
    }
  }

  private deflect(ball: ThrownBall, c: WildCreature, text: string): void {
    const b = ball.body;
    const away = Math.atan2(b.x - c.x, b.z - c.z);
    b.vx = Math.sin(away) * 3;
    b.vz = Math.cos(away) * 3;
    b.vy = 4;
    b.bounces++;
    for (const o of this.playersNear(b.x, b.z)) if (ball.known.has(o.id)) o.send({ type: "BALL_UPDATE", id: ball.id, kind: "deflect", x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz });
    const owner = this.players.get(ball.owner);
    if (owner && text) owner.send({ type: "TOAST", text, tone: "bad" });
  }

  private onBallHit(ball: ThrownBall, c: WildCreature): void {
    const p = this.players.get(ball.owner);
    if (!p) return this.removeBall(ball);
    const rec = ball.battleId ? this.battles.get(ball.battleId) : undefined;
    const name = c.species.name;

    if (c.owner && c.owner !== p.id) return this.deflect(ball, c, "");
    if (c.state === "capturing") return this.deflect(ball, c, "");
    if (ball.battleId) {
      if (!rec || rec.entity !== c) return this.deflect(ball, c, "배틀 중인 상대에게 던져야 한다!");
    } else if (c.state === "battle") {
      return this.deflect(ball, c, `${name}은(는) 다른 배틀 중이다.`);
    } else if (p.battle) {
      return this.deflect(ball, c, "");
    }
    if (c.special === "guardian") return this.deflect(ball, c, "볼이 튕겨 나왔다! 유적의 수호자는 잡을 수 없다.");
    const enc = c.species.encounter;
    if (enc?.requiresBattle && !rec) return this.deflect(ball, c, `${name}이(가) 볼을 쳐냈다! 먼저 배틀로 맞서야 잡을 수 있다.`);
    if (enc?.storyFlag && !p.save.quests.completed.includes(enc.storyFlag)) return this.deflect(ball, c, `${name}을(를) 아직은 잡을 수 없다.`);

    // Capture attempt
    const ctx = this.captureContext(p, c, ball.ball, rec);
    let roll = this.captures.roll(ctx, this.rng);
    if (!this.opts.multiplayer && this.forcedCapture) {
      const f = this.forcedCapture;
      this.forcedCapture = null;
      roll =
        f === "critical"
          ? { ...roll, critical: true, shakes: 1, success: true }
          : f === "success"
            ? { ...roll, critical: false, shakes: 3, success: true }
            : { ...roll, critical: false, shakes: 2, success: false };
    }
    ball.state = "capturing";
    if (rec) rec.ballInFlight = ball.id;
    c.state = "capturing";
    c.anim = "idle";
    c.target = null;
    c.dirty = true;
    this.markSeen(p, c.creature.species, false);

    const hit = { x: ball.body.x, y: ball.body.y, z: ball.body.z };
    const rest = this.ballRestPoint(hit.x, hit.y, hit.z);
    ball.body.x = rest.x;
    ball.body.y = rest.y;
    ball.body.z = rest.z;
    ball.body.vx = ball.body.vy = ball.body.vz = 0;
    const duration = captureDuration(roll.shakes, roll.critical);
    this.pending.push({ ball, creature: c, player: p, roll, at: this.now + duration, battleId: rec?.battle.id });
    const msg: ServerMessage = {
      type: "CAPTURE_SEQUENCE",
      ballId: ball.id,
      ball: ball.ball,
      targetId: c.id,
      species: c.creature.species,
      hit,
      rest,
      critical: roll.critical,
      shakes: roll.shakes,
      success: roll.success,
      duration,
    };
    for (const o of this.playersNear(hit.x, hit.z)) {
      ball.known.add(o.id);
      o.send(msg);
    }
    this.log(
      `capture ${c.creature.species} L${c.creature.level} a=${roll.modifiedRate.toFixed(1)} ball=x${roll.ballMultiplier} p=${roll.chance.toFixed(3)} -> ${roll.success ? "caught" : `broke out after ${roll.shakes}`}${roll.critical ? " (critical)" : ""}`,
    );
  }

  /** Where a ball falls after absorbing a Pokémon: straight down onto the floor or the water surface. */
  private ballRestPoint(x: number, y: number, z: number): { x: number; y: number; z: number } {
    const w = this.world;
    for (let yy = Math.floor(y); yy > Math.floor(y) - 40; yy--) {
      if (w.inWater(x, yy, z) && !w.inWater(x, yy + 1, z)) return { x, y: yy + 1 - 0.05, z };
      if (w.solid(x, yy, z)) return { x, y: yy + 1 + BALL.radius, z };
    }
    return { x, y, z };
  }

  private captureContext(p: Player, c: WildCreature, ball: string, rec?: BattleRecord): CaptureContext {
    const biome = this.world.biomeAt(c.x, c.y + 0.5, c.z);
    const toPlayer = Math.atan2(p.x - c.x, p.z - c.z);
    const facingAway = Math.cos(toPlayer - c.rotY) < 0;
    const party = p.save.party;
    return {
      speciesCatchRate: c.species.catchRate,
      currentHP: c.creature.hp,
      maxHP: maxHp(this.db, c.creature),
      level: c.creature.level,
      status: c.creature.status ?? "none",
      ball,
      battleTurn: rec ? rec.battle.turn : 1,
      inBattle: !!rec,
      biome,
      lightLevel: this.world.lightLevel(c.x, c.y + 0.5, c.z, this.daylight()),
      isCave: UNDERGROUND_BIOMES.includes(biome as never),
      isNight: this.clock().period === "night",
      isInWater: c.mode === "swim" || c.mode === "dive" || this.world.inWater(c.x, c.y + 0.3, c.z),
      isUnderwater: c.mode === "dive",
      targetTypes: c.species.types,
      previouslyCaught: p.save.caught.includes(c.creature.species),
      alpha: !!c.creature.alpha,
      legendary: !!c.species.legendary,
      rarity: c.rarity,
      playerLevel: party.length ? Math.max(...party.map((m) => m.level)) : 5,
      unaware: !rec && this.now > c.alertUntil && facingAway,
      caughtCount: p.save.caught.length,
    };
  }

  private finishCaptures(): void {
    const now = this.now;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pc = this.pending[i];
      if (now < pc.at) continue;
      this.pending.splice(i, 1);
      const { ball, creature: c, player: p, roll } = pc;
      const rec = pc.battleId ? this.battles.get(pc.battleId) : undefined;
      this.removeBall(ball);
      if (!this.players.has(p.id)) {
        c.state = "idle";
        c.dirty = true;
        continue;
      }
      if (roll.success) {
        const caught = c.creature;
        caught.ball = ball.ball;
        caught.origin = caught.origin ?? this.spawner.areaName(c.x, c.y, c.z) ?? this.world.biomeAt(c.x, c.y, c.z);
        const newSpecies = !p.save.caught.includes(caught.species);
        const sentTo = this.receiveCreature(p, caught);
        p.send({ type: "CAPTURE_RESULT", ballId: ball.id, targetId: c.id, success: true, creature: caught, sentTo, newSpecies });
        if (rec) {
          rec.ballInFlight = undefined;
          this.resolveBattleCapture(rec, true, false);
        } else {
          this.removeCreature(c, "captured");
          this.notify(p, this.quests.handle(p, { kind: "catch", species: caught.species }));
        }
        this.sendState(p);
        void this.persist(p);
      } else {
        c.state = "idle";
        c.anim = "recoil";
        c.alertUntil = now + 30;
        c.stateUntil = now + 1.5;
        c.dirty = true;
        let reaction: "flee" | "battle" | "watch" = "watch";
        if (rec) {
          rec.ballInFlight = undefined;
          c.state = "battle";
          this.resolveBattleCapture(rec, false, false);
        } else {
          const temper = c.species.behavior.temperament;
          if (temper === "aggressive" && this.healthy(p) && !p.battle && !c.special) {
            reaction = "battle";
            this.startBattle(p, "wild", [c.creature], { entity: c });
          } else if (temper === "timid") {
            reaction = "flee";
            startFlee(c, p.x, p.z, { now });
          } else {
            c.state = "watch";
            c.rotY = Math.atan2(p.x - c.x, p.z - c.z);
          }
        }
        p.send({ type: "CAPTURE_RESULT", ballId: ball.id, targetId: c.id, success: false, reaction });
      }
    }
  }

  private resolveBattleCapture(rec: BattleRecord, success: boolean, missed: boolean): void {
    const p = rec.player;
    const result = rec.battle.captureTurn(success, missed);
    const events = result.events;
    if (result.outcome) events.push(...this.finishBattle(rec, result.outcome, result.captured));
    p.send({ type: "BATTLE_RESULT", battle: rec.battle.view(), events, outcome: result.outcome });
    if (result.outcome) this.sendState(p);
  }

  private removeBall(ball: ThrownBall): void {
    if (!this.balls.delete(ball.id)) return;
    const b = ball.body;
    for (const id of ball.known) this.players.get(id)?.send({ type: "BALL_UPDATE", id: ball.id, kind: "remove", x: b.x, y: b.y, z: b.z });
  }

  private pickUpBalls(): void {
    for (const ball of [...this.balls.values()]) {
      if (ball.state !== "resting") continue;
      const p = this.players.get(ball.owner);
      if (!p || p.battle) continue;
      const b = ball.body;
      if (Math.hypot(p.x - b.x, p.y + 0.6 - b.y, p.z - b.z) > BALL.pickupRange) continue;
      this.balls.delete(ball.id);
      p.add(ball.ball);
      for (const id of ball.known) this.players.get(id)?.send({ type: "BALL_UPDATE", id: ball.id, kind: "pickup", x: b.x, y: b.y, z: b.z });
      const item = this.db.items.get(ball.ball);
      p.send({ type: "TOAST", text: `${item?.nameKo ?? item?.name ?? ball.ball}을(를) 주웠다.`, tone: "info" });
      this.sendState(p);
    }
  }

  // ---------------------------------------------------------------- creatures

  private addCreature(c: WildCreature): void {
    this.creatures.set(c.id, c);
    this.creatureIndex.upsert(c);
    this.schedule(c, this.tickCount + 1);
  }

  private removeCreature(c: WildCreature, reason: "captured" | "fled" | "despawn" | "defeated"): void {
    if (!this.creatures.delete(c.id)) return;
    this.creatureIndex.remove(c);
    this.lastAiTick.delete(c.id);
    for (const p of this.players.values()) {
      if (p.knownCreatures.delete(c.id)) p.send({ type: "POKEMON_DESPAWN", ids: [c.id], reason });
    }
  }

  private schedule(c: WildCreature, tick: number): void {
    c.nextTick = tick;
    let bucket = this.wheel.get(tick);
    if (!bucket) this.wheel.set(tick, (bucket = []));
    bucket.push(c);
  }

  private nearestPlayer(c: WildCreature): { player: Player | null; dist: number } {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const p of this.playerIndex.query(c.zone, c.x, c.z, DESPAWN_DISTANCE)) {
      const d = Math.hypot(p.x - c.x, (p.y - c.y) * 1.5, p.z - c.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return { player: best, dist: bestD };
  }

  // ---------------------------------------------------------------- tick

  tick(): void {
    const dt = 1 / TICK_RATE;
    this.tickCount++;
    const now = this.now;

    this.advanceClock(dt, now);
    this.stepBalls(dt);
    this.finishCaptures();
    this.runAI(now);
    if (this.tickCount % 5 === 0) this.pickUpBalls();
    if (this.tickCount % TICK_RATE === 0) this.runSpawns(now);
    if (this.tickCount % 2 === 0) this.replicate();

    for (const p of this.players.values()) {
      if (p.dirty && now - p.lastSavedAt > AUTOSAVE_SECONDS) void this.persist(p);
    }
    if (now > this.nextWorldSave) {
      this.nextWorldSave = now + WORLD_SAVE_SECONDS;
      void this.saveWorld();
    }
  }

  private advanceClock(dt: number, now: number): void {
    this.worldTime += dt;
    this.nextWeatherChange -= dt;
    if (this.nextWeatherChange <= 0) {
      const r = this.rng.next();
      this.weather = r < 0.68 ? "clear" : r < 0.9 ? "rain" : "fog";
      this.nextWeatherChange = this.rng.range(240, 480);
    }
    const clock = this.clock();
    if (clock.period !== this.lastPeriod || now >= this.nextClockBroadcast || clock.weather !== this.lastWeatherSent) {
      this.lastPeriod = clock.period;
      this.lastWeatherSent = clock.weather;
      this.nextClockBroadcast = now + 10;
      for (const p of this.players.values()) p.send({ type: "WORLD_EVENT", event: { kind: "clock", clock } });
    }
  }

  private runAI(now: number): void {
    const due = this.wheel.get(this.tickCount);
    if (!due) return;
    this.wheel.delete(this.tickCount);

    for (const c of due) {
      if (!this.creatures.has(c.id) || c.nextTick !== this.tickCount) continue;
      const { player, dist } = this.nearestPlayer(c);

      if (player) c.lastPlayerNear = now;
      else if (now - c.lastPlayerNear > 10 && c.state !== "battle" && c.state !== "capturing") {
        this.removeCreature(c, "despawn");
        continue;
      }

      const last = this.lastAiTick.get(c.id) ?? this.tickCount - 1;
      this.lastAiTick.set(c.id, this.tickCount);
      updateCreature(c, {
        world: this.world,
        rng: this.rng,
        now,
        dt: Math.min(1, (this.tickCount - last) / TICK_RATE),
        player,
        playerDist: dist,
        canEngage: (p) => !p.battle && this.healthy(p),
        engage: (cr, p) => {
          p.send({ type: "TOAST", text: `야생 ${cr.species.name}이(가) 덤벼들었다!`, tone: "bad" });
          this.startBattle(p, "wild", [cr.creature], { entity: cr });
        },
      });
      this.creatureIndex.upsert(c);
      this.schedule(c, this.tickCount + aiInterval(dist));
    }
  }

  private runSpawns(now: number): void {
    const clock = this.clock();
    for (const p of this.players.values()) {
      if (now < p.nextSpawnCheck || p.battle) continue;
      p.nextSpawnCheck = now + 0.8;
      if (this.creatures.size >= SPAWN_BUDGET_GLOBAL) return;
      let used = 0;
      for (const c of this.creatureIndex.query(p.zone, p.x, p.z, SPAWN_MAX_DISTANCE + 12)) if (!c.special) used += c.budget;
      if (used >= SPAWN_BUDGET_PER_PLAYER) continue;
      const occupied = (x: number, z: number, r: number) => this.creatureIndex.query(OVERWORLD, x, z, r).length > 0;
      const c = this.spawner.trySpawn(p, clock, this.rng, now, occupied);
      if (c && used + c.budget <= SPAWN_BUDGET_PER_PLAYER + 1) this.addCreature(c);
    }
  }

  /** Interest management: each player only hears about entities near them. */
  private replicate(): void {
    const playersMoved: Player[] = [];
    for (const p of this.players.values()) if (p.moved) playersMoved.push(p);

    for (const p of this.players.values()) {
      // Pokémon
      const near = this.creatureIndex.query(p.zone, p.x, p.z, INTEREST_RADIUS).filter((c) => !c.owner || c.owner === p.id);
      const nearIds = new Set(near.map((c) => c.id));
      const spawned = near.filter((c) => !p.knownCreatures.has(c.id));
      const moves: CreatureMove[] = [];
      for (const c of near) if (c.dirty && p.knownCreatures.has(c.id)) moves.push({ id: c.id, x: c.x, y: c.y, z: c.z, rotY: c.rotY, anim: c.anim });
      const gone = [...p.knownCreatures].filter((id) => !nearIds.has(id));

      for (const c of spawned) p.knownCreatures.add(c.id);
      for (const id of gone) p.knownCreatures.delete(id);
      if (spawned.length) p.send({ type: "POKEMON_SPAWN", creatures: spawned.map((c) => c.snapshot(this.db)) });
      if (gone.length) p.send({ type: "POKEMON_DESPAWN", ids: gone, reason: "despawn" });
      if (moves.length) p.send({ type: "POKEMON_MOVE", creatures: moves });

      // Balls lying around (players arriving later see them too)
      for (const ball of this.balls.values()) {
        if (ball.known.has(p.id) || ball.state !== "resting") continue;
        if (dist2(p.x, p.z, ball.body.x, ball.body.z) > INTEREST_RADIUS) continue;
        ball.known.add(p.id);
        p.send({ type: "BALL_SPAWN", ball: this.ballSnapshot(ball) });
      }

      // Other players
      const others = this.playerIndex.query(p.zone, p.x, p.z, INTEREST_RADIUS).filter((o) => o !== p);
      const otherIds = new Set(others.map((o) => o.id));
      for (const o of others) {
        if (!p.knownPlayers.has(o.id)) {
          p.knownPlayers.add(o.id);
          p.send({ type: "PLAYER_JOIN", player: o.snapshot(this.db) });
        }
      }
      for (const id of [...p.knownPlayers]) {
        if (!otherIds.has(id)) {
          p.knownPlayers.delete(id);
          p.send({ type: "PLAYER_LEAVE", id });
        }
      }
      const pm: RemotePlayerMove[] = playersMoved
        .filter((o) => o !== p && p.knownPlayers.has(o.id))
        .map((o) => {
          const s = o.snapshot(this.db);
          return { id: s.id, x: s.x, y: s.y, z: s.z, rotY: s.rotY, anim: s.anim, mount: s.mount, follower: s.follower, inBattle: s.inBattle };
        });
      if (pm.length) p.send({ type: "PLAYER_MOVE", players: pm });
    }

    for (const c of this.creatures.values()) c.dirty = false;
    for (const p of playersMoved) p.moved = false;
  }

  // ---------------------------------------------------------------- helpers

  private sendState(p: Player): void {
    p.send({ type: "PLAYER_STATE", state: p.privateState() });
  }

  private notify(p: Player, qc?: QuestChanges, lr?: LegendaryResult): void {
    if (qc && (qc.started.length || qc.completed.length)) {
      p.send({ type: "QUEST_UPDATE", quests: p.save.quests, started: qc.started, completed: qc.completed });
      for (const id of qc.completed) {
        const q = this.db.quests.get(id);
        const reward = qc.rewards.length ? ` (보상: ${qc.rewards.join(", ")})` : "";
        p.send({ type: "TOAST", text: `✔ 퀘스트 완료: ${q?.title ?? id}${reward}`, tone: "good" });
      }
      for (const id of qc.started) {
        const q = this.db.quests.get(id);
        p.send({ type: "TOAST", text: `새 퀘스트: ${q?.title ?? id}`, tone: "info" });
      }
      this.sendState(p);
    }
    if (lr && lr.progressed.length) {
      for (const clue of this.legend.clues(p)) p.send({ type: "WORLD_EVENT", event: { kind: "legendary", text: `전설의 단서 — ${clue.text}` } });
      if (p.save.legendary.completed.length && lr.progressed.some((t) => t.includes("Ho-Oh")))
        p.send({ type: "WORLD_EVENT", event: { kind: "legendary", text: "전설 이벤트 「새벽의 날개」를 완료했다!" } });
      this.sendState(p);
    }
  }

  // ---------------------------------------------------------------- debug / tests (single player only)

  debugTeleport(id: string, x: number, z: number, y?: number): boolean {
    if (this.opts.multiplayer) return false;
    const p = this.players.get(id);
    if (!p) return false;
    this.teleport(p, x, z, p.save.rotY, y);
    return true;
  }

  debugSetHour(hour: number): void {
    if (this.opts.multiplayer) return;
    const current = this.clock().hour;
    let delta = hour - current;
    if (delta < 0) delta += 24;
    this.worldTime += (delta / 24) * DAY_LENGTH_SECONDS;
    this.nextClockBroadcast = 0;
  }

  /** Spawns a specific wild Pokémon in front of a player. */
  debugSpawn(id: string, species: string, level: number, distance = 6, opts: { alpha?: boolean; hpFraction?: number } = {}): string | null {
    if (this.opts.multiplayer) return null;
    const p = this.players.get(id);
    const def = this.db.species.get(species);
    if (!p || !def) return null;
    const x = p.x + Math.sin(p.save.rotY) * distance;
    const z = p.z + Math.cos(p.save.rotY) * distance;
    const creature = createCreature(this.db, species, level, this.rng, { alpha: opts.alpha });
    if (opts.hpFraction !== undefined) creature.hp = Math.max(1, Math.round(maxHp(this.db, creature) * opts.hpFraction));
    const water = this.world.inWater(x, p.y + 0.5, z);
    const mode = water && def.movement.water ? "swim" : def.movement.land ? "walk" : def.movement.air ? "fly" : "swim";
    const feet = this.world.floorNear(x, p.y + 1, z, Math.ceil(def.hitbox.height * creature.size), 3, 8) ?? p.y;
    const y = mode === "fly" ? feet + 2 : mode === "swim" ? (this.world.waterSurface(x, p.y, z) ?? feet) - 0.5 : feet;
    const c = new WildCreature(randomId("w_", this.rng), creature, def, OVERWORLD, x, y, z, Math.atan2(p.x - x, p.z - z), mode, { x, y, z }, this.now);
    c.state = "idle";
    c.stateUntil = this.now + 30;
    this.addCreature(c);
    return c.id;
  }

  debugAddCreature(id: string, species: string, level: number): boolean {
    if (this.opts.multiplayer) return false;
    const p = this.players.get(id);
    if (!p || !this.db.species.has(species)) return false;
    this.receiveCreature(p, createCreature(this.db, species, level, this.rng));
    this.sendState(p);
    return true;
  }

  debugGive(id: string, item: string, n: number): boolean {
    if (this.opts.multiplayer) return false;
    const p = this.players.get(id);
    if (!p || !this.db.items.has(item)) return false;
    p.add(item, n);
    this.sendState(p);
    return true;
  }

  /** Forces the outcome of the next capture roll (tests of success / breakout / critical). */
  debugForceCapture(outcome: "success" | "fail" | "critical" | null): void {
    if (this.opts.multiplayer) return;
    this.forcedCapture = outcome;
  }

  /** For tests and the debug overlay. */
  inspect() {
    return {
      players: this.players.size,
      creatures: this.creatures.size,
      battles: this.battles.size,
      balls: this.balls.size,
      pendingCaptures: this.pending.length,
      clock: this.clock(),
    };
  }

  ballsNear(id: string): (BallSnapshot & { bounces: number })[] {
    const p = this.players.get(id);
    if (!p) return [];
    return [...this.balls.values()].filter((b) => dist2(p.x, p.z, b.body.x, b.body.z) < INTEREST_RADIUS).map((b) => ({ ...this.ballSnapshot(b), bounces: b.body.bounces }));
  }

  playerSave(id: string): PlayerSave | undefined {
    return this.players.get(id)?.save;
  }

  creaturesNear(id: string, radius = INTEREST_RADIUS) {
    const p = this.players.get(id);
    if (!p) return [];
    return this.creatureIndex.query(p.zone, p.x, p.z, radius).map((c) => c.snapshot(this.db));
  }

  creature(id: string): WildCreature | undefined {
    return this.creatures.get(id);
  }

  setAnimForTest(id: string, anim: AnimState): void {
    const p = this.players.get(id);
    if (p) p.anim = anim;
  }
}

function mergeChanges(a: QuestChanges, b: QuestChanges): QuestChanges {
  return { started: [...a.started, ...b.started], completed: [...a.completed, ...b.completed], rewards: [...a.rewards, ...b.rewards] };
}

function battleErrorText(code: string): string {
  const map: Record<string, string> = {
    "no PP left": "PP가 남아있지 않다!",
    "you have none left": "아이템이 없다!",
    "already at full HP": "HP가 이미 가득 차 있다.",
    "no status to cure": "상태이상이 없다.",
    "that creature has fainted": "기절한 포켓몬은 내보낼 수 없다.",
    "already in battle": "이미 싸우고 있다.",
    "can't run from this battle": "이 배틀에서는 도망칠 수 없다!",
    "choose a creature to send out": "다음 포켓몬을 골라야 한다.",
  };
  return map[code] ?? code;
}
