import {
  BATTLE_START_RANGE,
  CAPTURE_THROW_RANGE,
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
import type { ContentDB } from "@shared/data/contentDb";
import { createCreature, creatureName, healCreature, maxHp } from "@shared/data/stats";
import { Rng, randomId } from "@shared/math/rng";
import { dist2 } from "@shared/math/vec";
import type { ClientMessage, CreatureMove, PlayerAction, RemotePlayerMove, ServerMessage } from "@shared/protocol/messages";
import type { BattleAction, BattleEvent, BattleKind, BattleOutcome } from "@shared/types/battle";
import type { InteractableDef, NpcDef, Weather } from "@shared/types/content";
import type { AnimState, CreatureInstance, WorldClock } from "@shared/types/game";
import { type PlayerSave, type WorldSave, migrateSave } from "@shared/types/save";
import { clockAt } from "@shared/world/time";
import { OVERWORLD } from "@shared/world/terrain";
import { Battle } from "../battle/Battle";
import { rollCapture } from "../battle/capture";
import { type LegendaryBattleRequest, type LegendaryResult, LegendaryManager } from "../legendary/LegendaryManager";
import type { PlayerStore } from "../persistence/PlayerStore";
import { type Connection, Player } from "../player/Player";
import { aiInterval, updateCreature } from "../pokemon/CreatureAI";
import { evolveIfReady } from "../pokemon/progression";
import { WildCreature } from "../pokemon/WildCreature";
import { type QuestChanges, QuestManager } from "../quest/QuestManager";
import { SpawnManager } from "../spawn/SpawnManager";
import { SpatialIndex } from "../world/SpatialIndex";
import { World } from "../world/World";

export interface SimulationOptions {
  db: ContentDB;
  store: PlayerStore;
  /** Multiplayer servers require tokens to resume a player; local play does not. */
  multiplayer: boolean;
  seed?: number;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  log?: (msg: string) => void;
}

interface BattleRecord {
  battle: Battle;
  player: Player;
  entity?: WildCreature;
  legendary?: LegendaryBattleRequest;
  trainerId?: string;
}

const AUTOSAVE_SECONDS = 30;
const WORLD_SAVE_SECONDS = 60;
const MAX_MESSAGES_PER_SECOND = 80;

const secureRandomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * The authoritative game simulation. Runs unchanged in two hosts:
 *  - Node (server/src/main.ts) behind WebSockets for multiplayer
 *  - the browser (client LocalGameServer) for single player
 * Clients only send requests; every outcome is decided here.
 */
export class Simulation {
  readonly world: World;
  readonly db: ContentDB;
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
  /** Time wheel: tick -> creatures due for an AI update. */
  private readonly wheel = new Map<number, WildCreature[]>();
  private readonly lastAiTick = new Map<string, number>();

  private tickCount = 0;
  private worldTime = 0;
  private weather: Weather = "clear";
  private nextWeatherChange = 300;
  private lastPeriod = "";
  private nextClockBroadcast = 0;
  private nextWorldSave = WORLD_SAVE_SECONDS;
  private claimedLegendaries: string[] = [];

  constructor(private readonly opts: SimulationOptions) {
    this.db = opts.db;
    this.store = opts.store;
    this.world = new World(opts.db);
    this.rng = new Rng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
    this.spawner = new SpawnManager(opts.db, this.world);
    this.quests = new QuestManager(opts.db);
    this.legend = new LegendaryManager(opts.db);
    this.nowMs = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
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
    if (!this.world.hasZone(save.zone)) {
      save.zone = OVERWORLD;
      save.x = this.world.region.spawn.x;
      save.z = this.world.region.spawn.z;
    }
    // Never start inside terrain
    save.y = Math.max(save.y, this.world.ground(save.zone, save.x, save.z));

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
      y: this.world.ground(OVERWORLD, r.spawn.x + 0.5, r.spawn.z + 0.5),
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
        case "CAPTURE_THROW":
          return this.onCaptureThrow(p, msg.targetId, msg.item);
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
    const maxSpeed = mount ? (mount.modes.includes("fly") ? MOVE.fly : MOVE.run) * mount.speed : MOVE.run;
    const allowed = maxSpeed * 1.5 * dt + 2;
    const moved = dist2(p.save.x, p.save.z, m.x, m.z);

    const s = p.save;
    const ground = this.world.ground(s.zone, m.x, m.z, 0.25);
    const outOfBounds = !this.world.inBounds(s.zone, m.x, m.z, 1);
    const sunk = m.y < ground - 1.6 && this.world.waterDepth(s.zone, m.x, m.z) === 0;
    const tooHigh = !mount?.modes.includes("fly") && m.y > ground + 12;

    if (moved > allowed || outOfBounds || sunk || tooHigh) {
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
    for (const area of this.world.areasAt(p.zone, p.x, p.z)) {
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

  private near(p: Player, zone: string, x: number, z: number, range = INTERACT_RANGE + 1.5): boolean {
    return p.zone === zone && dist2(p.x, p.z, x, z) <= range;
  }

  private interact(p: Player, target: string): void {
    if (p.battle) return;
    const npc = this.world.npc(target);
    if (npc) {
      if (!this.near(p, this.world.zoneOfNpc(npc), npc.x, npc.z)) return p.send({ type: "TOAST", text: "너무 멀다.", tone: "bad" });
      return this.talkTo(p, npc);
    }
    const obj = this.world.interactable(target);
    if (obj) {
      if (!this.near(p, this.world.zoneOfInteractable(obj), obj.x, obj.z, INTERACT_RANGE + 2.5))
        return p.send({ type: "TOAST", text: "너무 멀다.", tone: "bad" });
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
            lines: [npc.dialogue[0], "여행을 떠나려면 파트너가 필요해. 셋 중 하나를 골라 보렴!"],
            choice: { kind: "starter", options: this.world.region.starters },
          });
        } else {
          p.send({ type: "DIALOG", speaker: npc.name, lines: npc.dialogue.slice(1) });
        }
        break;
      case "nurse":
        for (const c of p.save.party) healCreature(this.db, c);
        p.dirty = true;
        p.send({ type: "DIALOG", speaker: npc.name, lines: [npc.dialogue[0], "크리처들이 모두 건강해졌어요! 또 오세요."] });
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
          p.send({ type: "DIALOG", speaker: npc.name, lines: ["싸울 수 있는 크리처가 없잖아? 회복하고 다시 와!"] });
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
      case "cave_entrance": {
        const start = this.world.caveStart(obj.cave!);
        this.teleport(p, start.zone, start.x, start.z, 0);
        return p.send({ type: "TOAST", text: `${obj.name}에 들어왔다`, tone: "info" });
      }
      case "cave_exit": {
        const out = this.world.caveExitPoint(obj.cave!);
        const cave = this.world.region.caves.find((c) => c.id === obj.cave)!;
        this.teleport(p, OVERWORLD, out.x, out.z, Math.atan2(out.x - cave.entrance.x, out.z - cave.entrance.z));
        return p.send({ type: "TOAST", text: "동굴 밖으로 나왔다", tone: "info" });
      }
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
    if (prof && !this.near(p, this.world.zoneOfNpc(prof), prof.x, prof.z, 8)) return;

    const c = createCreature(this.db, species, 5, this.rng);
    c.caughtAt = Date.now();
    p.save.party.push(c);
    p.save.flags.starterChosen = true;
    this.markSeen(p, species, true);
    p.add("capture_orb", 5);
    p.dirty = true;

    const name = this.db.species.get(species)!.name;
    p.send({
      type: "DIALOG",
      speaker: prof?.name ?? "박사",
      lines: [`${name}(을)를 골랐구나! 잘 부탁해.`, "포획구 5개도 챙겨 가렴. 약해진 야생 크리처에게 던지면 잡을 수 있어!"],
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
    const seller = this.world.region.npcs.find(
      (n) => n.shop?.includes(itemId) && this.near(p, this.world.zoneOfNpc(n), n.x, n.z, INTERACT_RANGE + 4),
    );
    if (!seller) return p.send({ type: "TOAST", text: "상점 근처에서만 살 수 있다.", tone: "bad" });
    const cost = item.price * count;
    if (p.save.money < cost) return p.send({ type: "TOAST", text: "돈이 부족하다.", tone: "bad" });
    p.save.money -= cost;
    p.add(itemId, count);
    p.send({ type: "TOAST", text: `${item.name} ×${count} 구입 (-${cost}원)`, tone: "good" });
    this.sendState(p);
  }

  private useItem(p: Player, itemId: string, index: number): void {
    if (p.battle) return;
    const item = this.db.items.get(itemId);
    const c = p.save.party[index];
    if (!item || item.kind !== "heal" || !c) return;
    const max = maxHp(this.db, c);
    if (c.hp <= 0) return p.send({ type: "TOAST", text: "쓰러진 크리처에게는 쓸 수 없다. 회복 센터에 가자.", tone: "bad" });
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
      return p.send({ type: "TOAST", text: "탈 수 있는 크리처가 파티에 없다. (가시토끼·화염견·파도도롱뇽·강수달·하늘매 등)", tone: "bad" });
    }
    p.mounted = lead.species;
    p.moved = true;
    const modes = this.db.speciesOf(lead).mount!.modes;
    const how = modes.includes("fly") ? "하늘을 날 수 있다" : modes.includes("swim") ? "물 위를 달릴 수 있다" : "빠르게 달릴 수 있다";
    p.send({ type: "TOAST", text: `${creatureName(this.db, lead)}에 탔다! ${how}.`, tone: "good" });
    this.sendState(p);
  }

  private teleport(p: Player, zone: string, x: number, z: number, rotY: number): void {
    const s = p.save;
    const zoneChanged = s.zone !== zone;
    s.zone = zone;
    s.x = x;
    s.z = z;
    s.y = this.world.ground(zone, x, z);
    s.rotY = rotY;
    if (zoneChanged && p.mounted && this.db.species.get(p.mounted)?.mount?.modes.includes("fly") && this.world.ceiling(zone) !== null) {
      p.mounted = null;
    }
    this.playerIndex.upsert(p);
    if (zoneChanged) {
      if (p.knownCreatures.size) p.send({ type: "POKEMON_DESPAWN", ids: [...p.knownCreatures], reason: "despawn" });
      p.knownCreatures.clear();
      for (const id of p.knownPlayers) p.send({ type: "PLAYER_LEAVE", id });
      p.knownPlayers.clear();
    }
    p.moved = true;
    p.dirty = true;
    p.send({ type: "PLAYER_CORRECT", zone, x, y: s.y, z, rotY, reason: "teleport" });
    p.lastMoveAt = this.now;
    this.checkAreas(p);
  }

  // ---------------------------------------------------------------- battles

  private healthy(p: Player): boolean {
    return p.save.party.some((c) => c.hp > 0);
  }

  private requestWildBattle(p: Player, c: WildCreature): void {
    if (p.battle || c.state === "battle" || c.special) return;
    if (c.zone !== p.zone || dist2(p.x, p.z, c.x, c.z) > BATTLE_START_RANGE + 1) {
      return p.send({ type: "TOAST", text: "조금 더 가까이 가야 한다.", tone: "bad" });
    }
    if (!this.healthy(p)) {
      const msg = p.save.party.length === 0 ? "파트너가 없다! 마을 북쪽 연구소의 레아 박사를 찾아가자." : "싸울 수 있는 크리처가 없다. 회복 센터로 가자.";
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
      canCapture: kind === "wild" || kind === "legendary",
      canRun: kind === "wild" || kind === "legendary",
      captureBonus: kind === "legendary" ? 4 : 1,
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
      p.send({ type: "DIALOG", speaker: obj.name, lines: ["…기운이 다시 가라앉았다. 크리처를 회복하고 다시 오자."] });
      return;
    }
    const zone = this.world.zoneOfInteractable(obj);
    const away = Math.atan2(p.x - obj.x, p.z - obj.z);
    const x = obj.x + Math.sin(away) * 3.5;
    const z = obj.z + Math.cos(away) * 3.5;
    const creature = createCreature(this.db, req.species, req.level, this.rng);
    const species = this.db.species.get(req.species)!;
    const fly = species.behavior.movement.includes("fly") && !species.behavior.movement.includes("walk");
    const entity = new WildCreature(
      randomId("w_", this.rng),
      creature,
      species,
      zone,
      x,
      this.world.ground(zone, x, z) + (fly ? 2 : 0),
      z,
      away + Math.PI,
      fly ? "fly" : "walk",
      { x, z },
      this.now,
      undefined,
      req.kind === "guardian" ? "guardian" : "legendary",
      p.id,
    );
    this.addCreature(entity);
    this.startBattle(p, req.kind === "guardian" ? "guardian" : "legendary", [creature], { entity, legendary: req });
    p.send({ type: "WORLD_EVENT", event: { kind: "legendary", text: req.kind === "guardian" ? "유적의 수호자가 깨어났다!" : "새벽빛이 유적을 가득 채운다…!" } });
  }

  private onBattleAction(p: Player, battleId: string, action: BattleAction): void {
    const rec = this.battles.get(battleId);
    if (!rec || rec.player !== p) return;
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
          events.push({ t: "text", text: "전설의 크리처는 새벽빛 속으로 사라졌다… 제단을 다시 조사하면 또 만날 수 있을 것 같다." });
        }
        if (rec.entity) this.removeCreature(rec.entity, "defeated");
        break;
      }
      case "capture": {
        if (captured) {
          const where = this.receiveCreature(p, captured);
          events.push({ t: "text", text: `${creatureName(this.db, captured)}을(를) 잡았다! (${where === "party" ? "파티" : "보관함"}에 추가)` });
          qc = this.quests.handle(p, { kind: "catch", species: captured.species });
          if (rec.legendary) {
            lr = this.legend.onBattleResolved(p, rec.legendary, true);
            if (!this.claimedLegendaries.includes(`${p.id}:${rec.legendary.eventId}`))
              this.claimedLegendaries.push(`${p.id}:${rec.legendary.eventId}`);
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
        events.push({ t: "text", text: `눈앞이 캄캄해졌다… ${lost}원을 잃고 회복 센터로 돌아왔다.` });
        if (rec.entity) {
          if (rec.entity.special) this.removeCreature(rec.entity, "fled");
          else this.releaseCreature(rec.entity);
        }
        const r = this.world.region.respawn;
        this.teleport(p, OVERWORLD, r.x + 0.5, r.z + 0.5, Math.PI);
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

  // ---------------------------------------------------------------- capture

  private onCaptureThrow(p: Player, targetId: string, itemId: string): void {
    if (p.battle) return;
    const c = this.creatures.get(targetId);
    const item = this.db.items.get(itemId);
    const reply = (success: boolean, shakes: number, extra: Partial<Extract<ServerMessage, { type: "CAPTURE_RESULT" }>> = {}) =>
      p.send({ type: "CAPTURE_RESULT", targetId, item: itemId, shakes, success, ...extra });

    if (!item || item.kind !== "capture") return;
    if (!c || c.special || c.state === "battle" || c.zone !== p.zone) return reply(false, 0);
    if (dist2(p.x, p.z, c.x, c.z) > CAPTURE_THROW_RANGE + 1) {
      p.send({ type: "TOAST", text: "너무 멀다.", tone: "bad" });
      return reply(false, 0);
    }
    if (!p.consume(itemId)) {
      p.send({ type: "TOAST", text: `${item.name}이(가) 없다. 상점에서 살 수 있다.`, tone: "bad" });
      return reply(false, 0);
    }

    // Sneaking up from behind an unaware creature helps
    const toPlayer = Math.atan2(p.x - c.x, p.z - c.z);
    const facingAway = Math.cos(toPlayer - c.rotY) < -0.2;
    const unaware = (c.state === "idle" || c.state === "wander") && facingAway;
    const roll = rollCapture(this.db, c.creature, (item.captureBonus ?? 1) * (unaware ? 1.5 : 1), this.rng);
    this.markSeen(p, c.creature.species, false);

    if (roll.success) {
      const where = this.receiveCreature(p, c.creature);
      this.removeCreature(c, "captured");
      reply(true, roll.shakes, { creature: c.creature, sentTo: where });
      this.notify(p, this.quests.handle(p, { kind: "catch", species: c.creature.species }));
      this.sendState(p);
      return;
    }

    const temper = c.species.behavior.temperament;
    if (temper !== "timid" && this.healthy(p)) {
      reply(false, roll.shakes, { startedBattle: true });
      this.startBattle(p, "wild", [c.creature], { entity: c });
    } else {
      c.state = "flee";
      const ax = c.x - p.x;
      const az = c.z - p.z;
      const len = Math.hypot(ax, az) || 1;
      c.target = { x: c.x + (ax / len) * 16, z: c.z + (az / len) * 16 };
      c.stateUntil = this.now + 5;
      reply(false, roll.shakes);
    }
    this.sendState(p);
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
      const d = dist2(p.x, p.z, c.x, c.z);
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
    this.runAI(now);
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

  private lastWeatherSent: Weather = "clear";

  private runAI(now: number): void {
    const due = this.wheel.get(this.tickCount);
    if (!due) return;
    this.wheel.delete(this.tickCount);

    for (const c of due) {
      if (!this.creatures.has(c.id) || c.nextTick !== this.tickCount) continue;
      const { player, dist } = this.nearestPlayer(c);

      if (player) c.lastPlayerNear = now;
      else if (now - c.lastPlayerNear > 10 && c.state !== "battle") {
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
      p.nextSpawnCheck = now + 1;
      if (this.creatures.size >= SPAWN_BUDGET_GLOBAL) return;
      const near = this.creatureIndex.query(p.zone, p.x, p.z, SPAWN_MAX_DISTANCE + 12).filter((c) => !c.special).length;
      if (near >= SPAWN_BUDGET_PER_PLAYER) continue;
      const c = this.spawner.trySpawn(p, clock, this.rng, now);
      if (c) this.addCreature(c);
    }
  }

  /** Interest management: each player only hears about entities near them. */
  private replicate(): void {
    const playersMoved: Player[] = [];
    for (const p of this.players.values()) if (p.moved) playersMoved.push(p);

    for (const p of this.players.values()) {
      // Creatures
      const near = this.creatureIndex.query(p.zone, p.x, p.z, INTEREST_RADIUS).filter((c) => !c.owner || c.owner === p.id);
      const nearIds = new Set(near.map((c) => c.id));
      const spawned = near.filter((c) => !p.knownCreatures.has(c.id));
      const moves: CreatureMove[] = [];
      for (const c of near) if (c.dirty && p.knownCreatures.has(c.id)) moves.push({ id: c.id, x: c.x, y: c.y, z: c.z, rotY: c.rotY, anim: c.anim });
      const gone = [...p.knownCreatures].filter((id) => !nearIds.has(id));

      for (const c of spawned) p.knownCreatures.add(c.id);
      for (const id of gone) p.knownCreatures.delete(id);
      if (spawned.length) p.send({ type: "POKEMON_SPAWN", creatures: spawned.map((c) => c.snapshot()) });
      if (gone.length) p.send({ type: "POKEMON_DESPAWN", ids: gone, reason: "despawn" });
      if (moves.length) p.send({ type: "POKEMON_MOVE", creatures: moves });

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
      if (p.save.legendary.completed.length && lr.progressed.some((t) => t.includes("새벽날개")))
        p.send({ type: "WORLD_EVENT", event: { kind: "legendary", text: "전설 이벤트 「새벽의 날개」를 완료했다!" } });
      this.sendState(p);
    }
  }

  /** Debug/test hook: places a player (local single-player only). */
  debugTeleport(id: string, zone: string, x: number, z: number): boolean {
    if (this.opts.multiplayer) return false;
    const p = this.players.get(id);
    if (!p || !this.world.hasZone(zone)) return false;
    this.teleport(p, zone, x, z, p.save.rotY);
    return true;
  }

  /** Debug/test hook: sets time of day (local single-player only). */
  debugSetHour(hour: number): void {
    if (this.opts.multiplayer) return;
    const current = this.clock().hour;
    let delta = hour - current;
    if (delta < 0) delta += 24;
    this.worldTime += (delta / 24) * DAY_LENGTH_SECONDS;
    this.nextClockBroadcast = 0;
  }

  /** Debug/test hook: spawn a specific wild creature next to a player (local only). */
  debugSpawn(id: string, species: string, level: number, distance = 6): string | null {
    if (this.opts.multiplayer) return null;
    const p = this.players.get(id);
    const def = this.db.species.get(species);
    if (!p || !def) return null;
    const x = p.x + Math.sin(p.save.rotY) * distance;
    const z = p.z + Math.cos(p.save.rotY) * distance;
    const creature = createCreature(this.db, species, level, this.rng);
    const c = new WildCreature(randomId("w_", this.rng), creature, def, p.zone, x, this.world.ground(p.zone, x, z), z, 0, "walk", { x, z }, this.now);
    this.addCreature(c);
    return c.id;
  }

  /** Debug/test hook: grants a creature (local single-player only). */
  debugAddCreature(id: string, species: string, level: number): boolean {
    if (this.opts.multiplayer) return false;
    const p = this.players.get(id);
    if (!p || !this.db.species.has(species)) return false;
    this.receiveCreature(p, createCreature(this.db, species, level, this.rng));
    this.sendState(p);
    return true;
  }

  /** For tests and the debug overlay. */
  inspect() {
    return {
      players: this.players.size,
      creatures: this.creatures.size,
      battles: this.battles.size,
      clock: this.clock(),
    };
  }

  playerSave(id: string): PlayerSave | undefined {
    return this.players.get(id)?.save;
  }

  creaturesNear(id: string, radius = INTEREST_RADIUS) {
    const p = this.players.get(id);
    if (!p) return [];
    return this.creatureIndex.query(p.zone, p.x, p.z, radius).map((c) => c.snapshot());
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
    "that creature has fainted": "쓰러진 크리처는 내보낼 수 없다.",
    "already in battle": "이미 싸우고 있다.",
    "can't capture here": "이 배틀에서는 포획할 수 없다!",
    "can't run from this battle": "이 배틀에서는 도망칠 수 없다!",
    "choose a creature to send out": "다음 크리처를 골라야 한다.",
  };
  return map[code] ?? code;
}
