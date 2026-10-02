import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import { Scene } from "@babylonjs/core/scene";
import { CAPTURE_THROW_RANGE, BATTLE_START_RANGE, INTERACT_RANGE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { computeStats, creatureName } from "@shared/data/stats";
import { hashString } from "@shared/math/rng";
import { dist2 } from "@shared/math/vec";
import type { PlayerAction, ServerMessage } from "@shared/protocol/messages";
import type { NpcDef, RegionDef } from "@shared/types/content";
import type { PlayerPrivateState, PlayerSnapshot } from "@shared/types/game";
import { OVERWORLD } from "@shared/world/terrain";
import { Sky } from "../air/Sky";
import { BattleController } from "../battle/BattleController";
import { TouchControls } from "../mobile/TouchControls";
import { Device } from "../mobile/Device";
import type { GameConnection } from "../network/Connection";
import type { LocalConnection } from "../network/LocalGameServer";
import { CreatureLibrary } from "../pokemon/CreatureLibrary";
import { CreatureManager } from "../pokemon/CreatureManager";
import { Companion } from "../mount/MountVisual";
import { questHud } from "../quest/QuestTracker";
import { type ClientSettings, saveSettings, useTouchControls } from "../settings";
import { createTerrainMaterial } from "../terrain/TerrainMaterial";
import { BattleUI } from "../ui/BattleUI";
import { Dialog } from "../ui/Dialog";
import { Hud } from "../ui/Hud";
import { closeModal, modalOpen } from "../ui/Modal";
import { Panels } from "../ui/panels";
import { openMenu } from "../ui/Menu";
import { ChunkManager } from "../world/ChunkManager";
import { ClientTerrain } from "../world/ClientTerrain";
import { Structures } from "../world/Structures";
import { Sfx } from "./Audio";
import { Avatar, type AvatarLook } from "./Avatar";
import { CameraRig } from "./CameraRig";
import { Effects } from "./Effects";
import { createEngine } from "./EngineFactory";
import { type Action, Input } from "./Input";
import { createNameTag } from "./NameTag";
import { PlayerController } from "./PlayerController";

interface Remote {
  snap: PlayerSnapshot;
  avatar: Avatar;
  companion: Companion;
  target: Vector3;
  rot: number;
}

interface Target {
  kind: "npc" | "object" | "wild";
  id: string;
  label: string;
  pos: Vector3;
}

const PLAYER_LOOK: AvatarLook = { skin: "#f2c8a0", hair: "#3a2a20", shirt: "#e8463c", pants: "#2e4a7a" };
const SHIRTS = ["#3c8be8", "#5fbf4a", "#e8b43c", "#a45ae8", "#e8663c", "#3cc8c0", "#e84a9a"];

const WEATHER_LABEL: Record<string, string> = { clear: "☀ 맑음", rain: "🌧 비", fog: "🌫 안개" };

export interface GameOptions {
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  db: ContentDB;
  settings: ClientSettings;
  connection: GameConnection;
  name: string;
  onExit: () => void;
  onProgress?: (p: number, text: string) => void;
}

/** Owns the Babylon scene and wires renderer, network, world, entities, input and UI together. */
export class Game {
  readonly db: ContentDB;
  readonly region: RegionDef;
  engine!: AbstractEngine;
  engineKind = "webgl2";
  scene!: Scene;
  terrain: ClientTerrain;
  chunks!: ChunkManager;
  sky!: Sky;
  cam!: CameraRig;
  input!: Input;
  touch: TouchControls | null = null;
  hud!: Hud;
  dialog!: Dialog;
  panels!: Panels;
  battleUI!: BattleUI;
  battle!: BattleController;
  effects!: Effects;
  creatureLib!: CreatureLibrary;
  creatures!: CreatureManager;
  companion!: Companion;
  structures!: Structures;
  shadows: ShadowGenerator | null = null;
  readonly sfx = new Sfx();

  readonly controller = new PlayerController();
  private playerAvatar!: Avatar;
  private avatarMat!: StandardMaterial;
  private readonly npcs = new Map<string, { def: NpcDef; avatar: Avatar }>();
  private readonly remotes = new Map<string, Remote>();

  selfId = "";
  playerId = "";
  zone = OVERWORLD;
  state: PlayerPrivateState | null = null;
  private welcomed = false;
  private welcomeWaiters: (() => void)[] = [];
  private seq = 0;
  private lastSent = { t: 0, x: 0, y: 0, z: 0, rot: 0, anim: "" };
  private target: Target | null = null;
  private lastTargetScan = 0;
  private lastHud = 0;
  private sequencer: Promise<void> = Promise.resolve();
  private captureWaiter: ((r: Extract<ServerMessage, { type: "CAPTURE_RESULT" }>) => void) | null = null;
  private capturingId: string | null = null;
  private deferredDespawn: string[] = [];
  private talkingTo: string | null = null;
  private preferredOrb = "capture_orb";
  private disposed = false;
  private frameTimes: number[] = [];
  private lastFrame = performance.now();
  private netStatus = "";
  private readonly mapCache = new Map<string, Promise<ImageData>>();

  private constructor(private readonly opts: GameOptions) {
    this.db = opts.db;
    this.region = opts.db.defaultRegion();
    this.terrain = new ClientTerrain(this.region);
  }

  static async create(opts: GameOptions): Promise<Game> {
    const g = new Game(opts);
    await g.init();
    return g;
  }

  get settings(): ClientSettings {
    return this.opts.settings;
  }

  get connection(): GameConnection {
    return this.opts.connection;
  }

  private async init(): Promise<void> {
    const { canvas, ui, settings } = this.opts;
    const progress = this.opts.onProgress ?? (() => {});

    progress(0.1, "그래픽 엔진 준비 중…");
    const info = await createEngine(canvas, settings.renderer === "webgpu");
    this.engine = info.engine;
    this.engineKind = info.kind;
    this.applyResolution();

    const scene = new Scene(this.engine);
    this.scene = scene;
    // No mesh picking is used; drop Babylon's pointer handling (it preventDefaults pointerdown)
    scene.detachControl();
    scene.skipPointerMovePicking = true;
    scene.constantlyUpdateMeshUnderPointer = false;
    scene.autoClearDepthAndStencil = true;
    scene.blockMaterialDirtyMechanism = false;

    this.cam = new CameraRig(scene);
    this.sky = new Sky(scene, settings.particleBudget);
    this.sky.setViewDistance((settings.chunkRadius + 0.5) * 64);
    const { terrain: terrainMat } = createTerrainMaterial(scene);
    this.chunks = new ChunkManager(scene, terrainMat, this.region, settings);
    this.structures = new Structures(scene, this.region, this.terrain);
    this.effects = new Effects(scene, settings.particleBudget);
    this.creatureLib = new CreatureLibrary(scene, this.db);
    this.creatures = new CreatureManager(this.creatureLib, this.terrain, () => this.zone);
    this.companion = new Companion(this.creatureLib, this.terrain);

    this.avatarMat = new StandardMaterial("avatarMat", scene);
    this.avatarMat.specularColor = Color3.Black();
    this.playerAvatar = new Avatar(scene, this.avatarMat, PLAYER_LOOK, "player");
    this.setupShadows();

    // UI
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    this.hud = new Hud(ui);
    this.hud.onAction = (a) => this.input.press(a);
    this.dialog = new Dialog(ui);
    this.battleUI = new BattleUI(ui, this.db);
    this.panels = new Panels({
      db: this.db,
      region: this.region,
      state: () => this.state,
      send: (a) => this.action(a),
      get preferredOrb() {
        return game.preferredOrb;
      },
      set preferredOrb(v: string) {
        game.preferredOrb = v;
      },
    });

    this.input = new Input(canvas);
    this.input.sensitivity = settings.cameraSensitivity;
    this.input.invertY = settings.invertY;
    this.input.pointerLockAllowed = !Device.touch;
    if (useTouchControls(settings)) {
      this.touch = new TouchControls(ui, this.input);
      ui.insertBefore(this.touch.el, ui.firstChild);
    }
    this.hud.setKeyHints(!this.touch);

    this.battle = new BattleController({
      db: this.db,
      ui: this.battleUI,
      panels: this.panels,
      camera: this.cam,
      effects: this.effects,
      lib: this.creatureLib,
      creatures: this.creatures,
      terrain: this.terrain,
      zone: () => this.zone,
      playerPos: () => this.controller.pos.clone(),
      playerRot: () => this.controller.rotY,
      state: () => this.state,
      preferredOrb: () => this.preferredOrb,
      send: (battleId, action) => this.connection.send({ type: "BATTLE_ACTION", battleId, action }),
      onStart: () => {
        this.input.releasePointerLock();
        // The trainer steps aside: keep the camera's view of both creatures clear
        this.playerAvatar.setEnabled(false);
        this.hud.setVisible(false);
      },
      onEnd: () => {
        this.input.releasePointerLock();
        this.playerAvatar.setEnabled(true);
        this.hud.setVisible(true);
      },
      setFollowerHidden: (on) => this.companion.hide(on),
      sfx: (n) => this.sfx.play(n),
    });

    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    canvas.addEventListener("pointerdown", () => this.sfx.unlock(), { once: true });
    window.addEventListener("keydown", () => this.sfx.unlock(), { once: true });
    this.sfx.enabled = settings.sound;

    // Network
    progress(0.35, this.connection.mode === "online" ? "서버에 접속 중…" : "월드를 불러오는 중…");
    this.connection.onMessage = (m) => this.onMessage(m);
    this.connection.onStatus = (s, detail) => this.onNetStatus(s, detail);
    await this.connection.connect(this.opts.name);
    await new Promise<void>((resolve) => (this.welcomed ? resolve() : this.welcomeWaiters.push(resolve)));

    progress(0.6, "지형 생성 중…");
    await new Promise<void>((resolve) => {
      this.chunks.onReady = resolve;
      const pump = () => {
        if (this.disposed) return resolve();
        this.chunks.update(this.controller.pos.x, this.controller.pos.z, this.terrain.bounds(this.zone));
        if (this.chunks.onReady) requestAnimationFrame(pump);
      };
      pump();
    });
    progress(1, "준비 완료");

    this.engine.runRenderLoop(() => this.frame());
    this.exposeDebug();
  }

  // ------------------------------------------------------------------ setup helpers

  private applyResolution(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.engine.setHardwareScalingLevel(1 / (dpr * this.settings.renderScale));
  }

  private onResize = () => {
    this.applyResolution();
    this.engine.resize();
  };

  private setupShadows(): void {
    this.shadows?.dispose();
    this.shadows = null;
    const q = this.settings.shadows;
    this.chunks.shadows = null;
    if (q === "off") return;
    const size = q === "low" ? 1024 : q === "medium" ? 2048 : 4096;
    const sg = new ShadowGenerator(size, this.sky.sun);
    sg.bias = 0.0012;
    sg.normalBias = 0.02;
    if (q !== "low") {
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = q === "high" ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
    }
    const light = this.sky.sun;
    light.autoUpdateExtends = false;
    light.shadowMinZ = 1;
    light.shadowMaxZ = 220;
    const r = q === "high" ? 60 : 42;
    light.orthoLeft = -r;
    light.orthoRight = r;
    light.orthoTop = r;
    light.orthoBottom = -r;
    for (const m of this.playerAvatar.allMeshes()) sg.addShadowCaster(m, false);
    this.shadows = sg;
    this.chunks.shadows = sg;
    this.chunks.castTerrainShadows = q === "high";
  }

  applySettings(next: ClientSettings): void {
    const prev = this.opts.settings;
    this.opts.settings = next;
    saveSettings(next);
    this.applyResolution();
    this.chunks.setSettings(next);
    this.sky.setViewDistance((next.chunkRadius + 0.5) * 64);
    if (prev.particleBudget !== next.particleBudget) {
      this.sky.setParticleBudget(next.particleBudget);
      this.effects.setBudget(next.particleBudget);
    }
    if (prev.shadows !== next.shadows || prev.chunkRadius !== next.chunkRadius || prev.vegetationRadius !== next.vegetationRadius) {
      this.setupShadows();
      const zone = this.zone;
      this.chunks.setZone("");
      this.chunks.setZone(zone);
    }
    this.input.sensitivity = next.cameraSensitivity;
    this.input.invertY = next.invertY;
    this.sfx.enabled = next.sound;
    const wantTouch = useTouchControls(next);
    if (wantTouch && !this.touch) {
      this.touch = new TouchControls(this.opts.ui, this.input);
      this.opts.ui.insertBefore(this.touch.el, this.opts.ui.firstChild);
    }
    this.touch?.setVisible(wantTouch);
    this.hud.setKeyHints(!wantTouch);
  }

  // ------------------------------------------------------------------ network

  private onNetStatus(status: string, detail?: string): void {
    if (this.connection.mode === "local") {
      this.netStatus = "싱글 플레이";
    } else {
      this.netStatus = status === "open" ? "🟢 온라인" : status === "reconnecting" ? `🟠 재연결 중… ${detail ?? ""}` : status === "connecting" ? "🟡 접속 중…" : "🔴 연결 끊김";
      const overlay = document.getElementById("reconnect-overlay");
      overlay?.classList.toggle("hidden", status !== "reconnecting");
      if (overlay && detail) overlay.querySelector(".detail")!.textContent = detail;
    }
    this.hud?.setNet(this.netStatus);
  }

  private action(a: PlayerAction): void {
    this.connection.send({ type: "PLAYER_ACTION", action: a });
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case "WELCOME": {
        const reconnect = this.welcomed;
        this.selfId = m.playerId;
        this.playerId = m.playerId;
        this.state = m.state;
        this.sky.setClock(m.clock);
        if (reconnect) {
          this.creatures.clear();
          for (const r of this.remotes.values()) this.removeRemote(r);
          this.remotes.clear();
          this.battle.cleanup();
          this.hud.toast("서버에 다시 연결되었습니다.", "good");
        }
        this.setZone(m.self.zone);
        this.controller.teleport(m.self.x, m.self.y, m.self.z, m.self.rotY);
        this.cam.yaw = m.self.rotY;
        this.cam.snap();
        this.applyMount();
        this.welcomed = true;
        for (const w of this.welcomeWaiters.splice(0)) w();
        break;
      }
      case "PLAYER_STATE":
        this.state = m.state;
        this.applyMount();
        this.panels.refresh();
        break;
      case "PLAYER_JOIN":
        this.addRemote(m.player);
        break;
      case "PLAYER_LEAVE": {
        const r = this.remotes.get(m.id);
        if (r) this.removeRemote(r);
        this.remotes.delete(m.id);
        break;
      }
      case "PLAYER_MOVE":
        for (const p of m.players) {
          const r = this.remotes.get(p.id);
          if (!r) continue;
          r.target.set(p.x, p.y, p.z);
          r.rot = p.rotY;
          r.snap = { ...r.snap, ...p };
          r.avatar.pose = p.mount ? "sit" : p.anim;
          r.companion.set(p.mount ?? p.follower ?? null, p.mount ? "mount" : "follow");
          r.companion.hide(p.inBattle && !p.mount);
        }
        break;
      case "PLAYER_CORRECT":
        if (m.zone !== this.zone) this.setZone(m.zone);
        this.controller.teleport(m.x, m.y, m.z, m.rotY);
        this.lastSent = { ...this.lastSent, x: m.x, y: m.y, z: m.z };
        if (m.reason === "teleport") {
          if (m.rotY !== undefined) this.cam.yaw = m.rotY;
          this.cam.snap();
        }
        break;
      case "POKEMON_SPAWN":
        this.creatures.spawn(m.creatures.filter((c) => c.zone === this.zone));
        break;
      case "POKEMON_DESPAWN": {
        const now: string[] = [];
        for (const id of m.ids) {
          if (id === this.capturingId) this.deferredDespawn.push(id);
          else if (this.battle.view?.entityId === id && m.reason !== "defeated" && m.reason !== "captured") this.deferredDespawn.push(id);
          else now.push(id);
        }
        this.creatures.despawn(now, m.reason);
        break;
      }
      case "POKEMON_MOVE":
        this.creatures.move(m.creatures);
        break;
      case "BATTLE_START":
        this.sequencer = this.sequencer.then(() => this.battle.start(m.battle));
        break;
      case "BATTLE_RESULT":
        this.sequencer = this.sequencer.then(() => this.battle.result(m));
        if (m.outcome) this.sequencer = this.sequencer.then(() => this.flushDeferred());
        break;
      case "CAPTURE_RESULT":
        this.captureWaiter?.(m);
        break;
      case "QUEST_UPDATE":
        if (this.state) this.state.quests = m.quests;
        break;
      case "WORLD_EVENT":
        if (m.event.kind === "clock") this.sky.setClock(m.event.clock);
        else this.hud.toast(m.event.text, m.event.kind === "legendary" ? "legend" : "info");
        break;
      case "DIALOG":
        this.showDialog(m.speaker, m.lines, m.choice);
        break;
      case "TOAST":
        this.hud.toast(m.text, m.tone);
        break;
      case "ERROR":
        this.hud.toast(m.message, "bad");
        if (m.code === "replaced" || m.code === "protocol") {
          this.connection.close();
          setTimeout(() => this.exit(), 2500);
        }
        break;
      case "PONG":
        break;
    }
  }

  private flushDeferred(): void {
    if (this.deferredDespawn.length) this.creatures.despawn(this.deferredDespawn.splice(0), "despawn");
  }

  private async showDialog(speaker: string, lines: string[], choice?: Extract<ServerMessage, { type: "DIALOG" }>["choice"]): Promise<void> {
    const npc = [...this.npcs.values()].find((n) => n.def.name === speaker);
    this.talkingTo = npc?.def.id ?? null;
    this.input.releasePointerLock();
    await this.dialog.show(speaker, lines);
    this.talkingTo = null;
    if (choice?.kind === "starter") this.panels.starter(choice.options, (species) => this.action({ kind: "choose_starter", species }));
    else if (choice?.kind === "shop") this.panels.shop(choice.items);
  }

  // ------------------------------------------------------------------ world

  private setZone(zone: string): void {
    const changed = zone !== this.zone || !this.chunks.chunkCount;
    this.zone = zone;
    if (!changed && this.npcs.size) return;
    this.chunks.setZone(zone);
    this.structures.build(zone);
    this.sky.setUnderground(zone !== OVERWORLD);
    this.creatures.clear();
    for (const n of this.npcs.values()) n.avatar.dispose();
    this.npcs.clear();
    for (const def of this.region.npcs) {
      if ((def.zone ?? OVERWORLD) !== zone) continue;
      const avatar = new Avatar(this.scene, this.avatarMat, def.look, `npc_${def.id}`);
      avatar.root.position.set(def.x + 0.5, this.terrain.ground(zone, def.x + 0.5, def.z + 0.5, 0.3), def.z + 0.5);
      avatar.root.rotation.y = def.facing;
      this.npcs.set(def.id, { def, avatar });
      if (this.shadows) for (const m of avatar.allMeshes()) this.shadows.addShadowCaster(m, false);
    }
  }

  private applyMount(): void {
    const st = this.state;
    const lead = st?.party.find((c) => c.hp > 0);
    if (st?.mounted) {
      const mount = st.party.find((c) => c.hp > 0 && this.db.speciesOf(c).mount);
      const def = mount ? this.db.speciesOf(mount).mount : undefined;
      this.controller.mountModes = def?.modes ?? [];
      this.controller.mountSpeed = def?.speed ?? 1;
      this.companion.set(mount?.species ?? null, "mount");
    } else {
      this.controller.mountModes = [];
      this.controller.mountSpeed = 1;
      this.companion.set(lead?.species ?? null, "follow");
    }
  }

  private addRemote(p: PlayerSnapshot): void {
    if (this.remotes.has(p.id) || p.id === this.selfId) return;
    const h = hashString(p.id);
    const look: AvatarLook = { skin: "#f0c8a0", hair: h % 2 ? "#2a2a2a" : "#8a5a2a", shirt: SHIRTS[h % SHIRTS.length], pants: "#2e3a5a" };
    const avatar = new Avatar(this.scene, this.avatarMat, look, `remote_${p.id}`);
    avatar.root.position.set(p.x, p.y, p.z);
    createNameTag(this.scene, p.name, avatar.root);
    const companion = new Companion(this.creatureLib, this.terrain);
    companion.set(p.mount ?? p.follower ?? null, p.mount ? "mount" : "follow");
    this.remotes.set(p.id, { snap: p, avatar, companion, target: new Vector3(p.x, p.y, p.z), rot: p.rotY });
  }

  private removeRemote(r: Remote): void {
    r.avatar.dispose();
    r.companion.dispose();
  }

  // ------------------------------------------------------------------ frame

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    if (this.settings.maxFps === 30 && now - this.lastFrame < 31) return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const busy = this.dialog.open || modalOpen() || this.battle.active || !this.welcomed;
    this.input.gameplayEnabled = !busy;
    this.touch?.setGameplay(!busy);
    const controls = this.input.frame();
    this.handleActions(controls.pressed, busy);

    if (!this.battle.active) this.controller.update(dt, controls, this.cam.yaw, this.terrain, this.zone);

    // Player avatar (+ ridden creature)
    const seat = this.companion.seat;
    const pos = this.controller.pos;
    this.playerAvatar.root.position.set(pos.x, pos.y + seat, pos.z);
    this.playerAvatar.root.rotation.y = this.controller.rotY;
    this.playerAvatar.pose = this.controller.mounted ? "sit" : this.controller.anim;
    this.playerAvatar.update(dt);
    if (!this.battle.active) this.companion.update(dt, this.zone, pos, this.controller.rotY, this.controller.anim);

    this.sendMovement(now);

    this.chunks.update(pos.x, pos.z, this.terrain.bounds(this.zone));
    this.creatures.update(dt, this.cam.camera.position, this.settings.creatureViewDistance);
    this.battle.update(dt);
    this.updateRemotes(dt);
    this.updateNpcs(dt);

    if (now - this.lastTargetScan > 100) {
      this.lastTargetScan = now;
      this.scanTarget();
    }
    this.updatePromptAndTag();

    this.cam.update(dt, this.playerAvatar.root.position, controls, this.terrain, this.zone);
    this.sky.update(dt, pos, this.cam.camera.position);
    this.structures.update(now / 1000);

    if (now - this.lastHud > 250) {
      this.lastHud = now;
      this.updateHud();
    }
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.settings.showFps) this.hud.setFps(this.frameTimes.length / this.frameTimes.reduce((a, b) => a + b, 0));
    else this.hud.setFps(null);

    this.scene.render();
  }

  private handleActions(pressed: Set<Action>, busy: boolean): void {
    for (const a of pressed) {
      if (a === "close") {
        if (modalOpen()) closeModal();
        continue;
      }
      if (this.battle.active || this.dialog.open) continue;
      if (a === "party" || a === "bag" || a === "map" || a === "menu") {
        this.input.releasePointerLock();
        if (modalOpen()) {
          closeModal();
          continue;
        }
        if (a === "party") this.panels.party();
        else if (a === "bag") this.panels.bag();
        else if (a === "map") this.openMap();
        else openMenu(this);
        continue;
      }
      if (busy) continue;
      if (a === "interact") this.interact();
      else if (a === "attack") this.startBattle();
      else if (a === "capture") void this.throwCapture();
      else if (a === "mount") this.action({ kind: "mount", on: !this.state?.mounted });
    }
  }

  private sendMovement(now: number): void {
    if (this.battle.active || !this.welcomed) return;
    const p = this.controller.pos;
    const s = this.lastSent;
    const moved = Math.abs(p.x - s.x) + Math.abs(p.y - s.y) + Math.abs(p.z - s.z) > 0.03;
    const turned = Math.abs(this.controller.rotY - s.rot) > 0.05;
    const anim = this.controller.anim;
    if (now - s.t < 100 || (!moved && !turned && anim === s.anim)) return;
    this.connection.send({ type: "PLAYER_MOVE", seq: ++this.seq, x: p.x, y: p.y, z: p.z, rotY: this.controller.rotY, anim });
    this.lastSent = { t: now, x: p.x, y: p.y, z: p.z, rot: this.controller.rotY, anim };
  }

  private updateRemotes(dt: number): void {
    for (const r of this.remotes.values()) {
      const root = r.avatar.root;
      if (Vector3.Distance(root.position, r.target) > 15) root.position.copyFrom(r.target);
      else root.position.copyFrom(Vector3.Lerp(root.position, r.target, Math.min(1, dt * 10)));
      root.rotation.y += (((r.rot - root.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 10);
      r.avatar.update(dt);
      const seat = r.companion.seat;
      const base = root.position.clone();
      if (seat) root.position.y = r.target.y + seat;
      r.companion.update(dt, this.zone, new Vector3(base.x, r.target.y, base.z), root.rotation.y, r.snap.anim);
    }
  }

  private updateNpcs(dt: number): void {
    const p = this.controller.pos;
    for (const n of this.npcs.values()) {
      const a = n.avatar;
      if (Vector3.DistanceSquared(a.root.position, p) > 3600) continue;
      if (this.talkingTo === n.def.id) {
        a.root.rotation.y = Math.atan2(p.x - a.root.position.x, p.z - a.root.position.z);
        a.pose = "talk";
      } else {
        a.pose = "idle";
      }
      a.update(dt);
    }
  }

  // ------------------------------------------------------------------ interaction

  private scanTarget(): void {
    const p = this.controller.pos;
    let best: Target | null = null;
    let bestD = INTERACT_RANGE;
    for (const n of this.npcs.values()) {
      const d = dist2(p.x, p.z, n.def.x + 0.5, n.def.z + 0.5);
      if (d < bestD) {
        bestD = d;
        const verb = n.def.role === "trainer" ? "에게 말 걸기" : n.def.role === "clerk" ? "(상점)" : n.def.role === "nurse" ? "(회복)" : "와(과) 대화";
        best = { kind: "npc", id: n.def.id, label: `${n.def.name}${verb}`, pos: n.avatar.root.position.add(new Vector3(0, 2.2, 0)) };
      }
    }
    for (const it of this.region.interactables) {
      if ((it.zone ?? OVERWORLD) !== this.zone) continue;
      const d = dist2(p.x, p.z, it.x + 0.5, it.z + 0.5);
      const range = it.kind === "altar" || it.kind === "cave_entrance" || it.kind === "cave_exit" ? INTERACT_RANGE + 1.5 : INTERACT_RANGE;
      if (d < Math.min(bestD + 0.01, range) || (d < range && !best)) {
        bestD = d;
        const verb: Record<string, string> = {
          sign: "읽기",
          cave_entrance: "들어가기",
          cave_exit: "밖으로 나가기",
          crystal: "조사하기",
          tablet: "조사하기",
          altar: "조사하기",
        };
        best = { kind: "object", id: it.id, label: `${it.name} ${verb[it.kind] ?? "조사하기"}`, pos: new Vector3(it.x + 0.5, this.terrain.height(this.zone, it.x, it.z) + 1.5, it.z + 0.5) };
      }
    }
    if (!best) {
      const w = this.creatures.nearest(p, BATTLE_START_RANGE, (e) => e.view.root.isEnabled());
      if (w) {
        const s = this.db.species.get(w.snap.species)!;
        best = { kind: "wild", id: w.snap.id, label: `야생 ${s.name} Lv.${w.snap.level} — 배틀`, pos: w.view.root.position.add(new Vector3(0, w.view.height + 0.3, 0)) };
      }
    }
    this.target = best;
  }

  private updatePromptAndTag(): void {
    const busy = this.dialog.open || modalOpen() || this.battle.active;
    const t = busy ? null : this.target;
    this.hud.showPrompt(t ? t.label : null, this.touch ? "A" : "E");

    // Floating name over the nearest wild creature in view (within throw range)
    let tag: { pos: Vector3; text: string } | null = null;
    if (!busy) {
      const w = this.creatures.nearest(this.controller.pos, CAPTURE_THROW_RANGE, (e) => e.view.root.isEnabled());
      if (w) {
        const s = this.db.species.get(w.snap.species)!;
        tag = { pos: w.view.root.position.add(new Vector3(0, w.view.height + 0.25, 0)), text: `${s.name} Lv.${w.snap.level}` };
      }
    }
    if (tag) {
      const engine = this.engine;
      const v = Vector3.Project(
        tag.pos,
        Matrix.Identity(),
        this.scene.getTransformMatrix(),
        this.cam.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()),
      );
      const scale = engine.getHardwareScalingLevel();
      if (v.z > 0 && v.z < 1) this.hud.showTarget(v.x * scale, v.y * scale, tag.text, true);
      else this.hud.showTarget(0, 0, null, true);
    } else this.hud.showTarget(0, 0, null, true);
  }

  private interact(): void {
    const t = this.target;
    if (!t) return;
    if (t.kind === "wild") this.action({ kind: "battle", target: t.id });
    else this.action({ kind: "interact", target: t.id });
  }

  private startBattle(): void {
    const w = this.creatures.nearest(this.controller.pos, BATTLE_START_RANGE + 1, (e) => e.view.root.isEnabled());
    if (!w) {
      this.hud.toast("근처에 배틀할 야생 크리처가 없다. 가까이 다가가자!", "bad");
      return;
    }
    this.action({ kind: "battle", target: w.snap.id });
  }

  private pickOrb(): string | null {
    const inv = this.state?.inventory ?? {};
    if ((inv[this.preferredOrb] ?? 0) > 0) return this.preferredOrb;
    return Object.keys(inv).find((id) => this.db.items.get(id)?.kind === "capture" && (inv[id] ?? 0) > 0) ?? null;
  }

  private async throwCapture(): Promise<void> {
    if (this.capturingId) return;
    const orb = this.pickOrb();
    if (!orb) {
      this.hud.toast("포획구가 없다! 상점에서 살 수 있다.", "bad");
      return;
    }
    const p = this.controller.pos;
    const yaw = this.cam.yaw;
    // Prefer creatures in front of the camera
    const w =
      this.creatures.nearest(p, CAPTURE_THROW_RANGE, (e) => {
        if (!e.view.root.isEnabled()) return false;
        const dx = e.view.root.position.x - p.x;
        const dz = e.view.root.position.z - p.z;
        return (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / Math.max(0.01, Math.hypot(dx, dz)) > 0.35;
      }) ?? this.creatures.nearest(p, 8, (e) => e.view.root.isEnabled());
    if (!w) {
      this.hud.toast("포획구를 던질 크리처가 주변에 없다.", "bad");
      return;
    }

    const id = w.snap.id;
    this.capturingId = id;
    const item = this.db.items.get(orb)!;
    const targetPos = w.view.root.position.clone();
    this.controller.rotY = Math.atan2(targetPos.x - p.x, targetPos.z - p.z);
    this.playerAvatar.playThrow();
    this.sfx.play("throw");

    const result = new Promise<Extract<ServerMessage, { type: "CAPTURE_RESULT" }> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 6000);
      this.captureWaiter = (r) => {
        if (r.targetId !== id) return;
        clearTimeout(timer);
        resolve(r);
      };
    });
    this.connection.send({ type: "CAPTURE_THROW", targetId: id, item: orb });

    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    this.sequencer = this.sequencer.then(() => done);

    try {
      await this.effects.throwOrb(p.add(new Vector3(0, 1.6, 0)), targetPos.add(new Vector3(0, w.view.height * 0.5, 0)), item.color);
      const r = await result;
      if (!r || r.shakes === 0 && !r.success) {
        this.effects.hideOrb(false);
        if (r) this.hud.toast("포획구가 튕겨 나갔다!", "bad");
        return;
      }
      w.held = true;
      w.view.setVisible(false);
      const ground = this.terrain.ground(this.zone, targetPos.x, targetPos.z, 0.2);
      const level = this.terrain.waterLevel(this.zone);
      await this.effects.shakeOrb(new Vector3(targetPos.x, Math.max(ground, level ?? ground) + 0.16, targetPos.z), r.shakes);
      this.effects.hideOrb(r.success);
      if (r.success) {
        this.sfx.play("capture");
        const name = r.creature ? creatureName(this.db, r.creature) : "크리처";
        this.hud.toast(`${name}을(를) 잡았다! (${r.sentTo === "box" ? "보관함" : "파티"}에 추가)`, "good");
      } else {
        w.held = false;
        this.hud.toast(r.startedBattle ? "포획구에서 빠져나와 덤벼든다!" : "포획구에서 빠져나와 도망쳤다!", "bad");
      }
    } finally {
      this.captureWaiter = null;
      this.capturingId = null;
      const pending = this.deferredDespawn.filter((d) => d === id);
      if (pending.length) {
        this.deferredDespawn = this.deferredDespawn.filter((d) => d !== id);
        this.creatures.despawn(pending, "captured");
      }
      release();
    }
  }

  // ------------------------------------------------------------------ HUD

  private updateHud(): void {
    const st = this.state;
    const p = this.controller.pos;
    const area = this.region.areas.find((a) => (a.zone ?? OVERWORLD) === this.zone && dist2(p.x, p.z, a.x, a.z) <= a.radius && a.radius < 100) ??
      this.region.areas.find((a) => (a.zone ?? OVERWORLD) === this.zone && dist2(p.x, p.z, a.x, a.z) <= a.radius);
    this.hud.setLocation(area?.name ?? (this.zone === OVERWORLD ? this.region.name : "동굴"));
    const hour = this.sky.hour;
    const hh = Math.floor(hour);
    const mm = Math.floor((hour - hh) * 60);
    const icon = hour >= 6 && hour < 18 ? "🌤" : "🌙";
    this.hud.setMeta(`${icon} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, this.zone === OVERWORLD ? WEATHER_LABEL[this.sky.weather] : "⛏ 지하", st?.money ?? 0);
    const lead = st?.party[0];
    if (lead) {
      const s = this.db.speciesOf(lead);
      this.hud.setLead({ name: creatureName(this.db, lead), level: lead.level, hp: lead.hp, maxHp: computeStats(s, lead.level, lead.ivs).hp, color: s.model.colors.primary });
    } else this.hud.setLead(null);
    this.hud.setQuest(st ? questHud(this.db, st) : "");
    this.hud.setNet(this.netStatus);
  }

  openMap(): void {
    const zone = this.zone;
    let bounds: { minX: number; minZ: number; span: number };
    let size: number;
    let scale: number;
    if (zone === OVERWORLD) {
      const r = this.region;
      const minX = r.mountains.westX - 40;
      const maxX = r.coast.eastX + 60;
      const minZ = r.coast.deepZ - 40;
      const maxZ = r.mountains.northZ + 40;
      const span = Math.max(maxX - minX, maxZ - minZ);
      scale = Math.ceil(span / 240);
      size = Math.ceil(span / scale);
      bounds = { minX, minZ, span: size * scale };
    } else {
      const b = this.terrain.bounds(zone)!;
      scale = 1;
      size = b.maxX - b.minX;
      bounds = { minX: b.minX, minZ: b.minZ, span: size };
    }
    let image = this.mapCache.get(zone);
    if (!image) {
      image = this.chunks.requestMap(zone, bounds.minX, bounds.minZ, size, scale);
      this.mapCache.set(zone, image);
    }
    const p = this.controller.pos;
    this.panels.map({ zone, image, bounds, player: { x: p.x, z: p.z, rotY: this.controller.rotY } });
  }

  async saveGame(): Promise<void> {
    if (this.connection.mode === "local") await (this.connection as LocalConnection).saveNow();
    this.action({ kind: "save" });
  }

  exit(): void {
    if (this.disposed) return;
    this.dispose();
    this.opts.onExit();
  }

  dispose(): void {
    this.disposed = true;
    this.connection.close();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
    this.input.releasePointerLock();
    this.chunks.dispose();
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
    this.opts.ui.replaceChildren();
    delete (window as unknown as { __pokeworld?: unknown }).__pokeworld;
  }

  // ------------------------------------------------------------------ debug / tests

  private exposeDebug(): void {
    const local = this.connection.mode === "local" ? (this.connection as LocalConnection) : null;
    const game = this;
    (window as unknown as { __pokeworld: unknown }).__pokeworld = {
      game,
      get state() {
        return game.state;
      },
      get pos() {
        const p = game.controller.pos;
        return { x: p.x, y: p.y, z: p.z, zone: game.zone, rotY: game.controller.rotY, anim: game.controller.anim };
      },
      get yaw() {
        return game.cam.yaw;
      },
      set yaw(v: number) {
        game.cam.yaw = v;
      },
      get battle() {
        return game.battle.view;
      },
      get target() {
        return game.target;
      },
      get chunks() {
        return { loaded: game.chunks.loadedCount, total: game.chunks.chunkCount };
      },
      get engineKind() {
        return game.engineKind;
      },
      get remotes() {
        return [...game.remotes.values()].map((r) => ({ id: r.snap.id, name: r.snap.name, x: r.target.x, z: r.target.z }));
      },
      get netStatus() {
        return game.netStatus;
      },
      creatures: () => [...game.creatures.all()].map((w) => ({ ...w.snap, x: w.view.root.position.x, z: w.view.root.position.z })),
      stats: () => ({
        fps: game.engine.getFps(),
        drawCalls: (game.scene as unknown as { getEngine: () => { _drawCalls?: { current: number } } }).getEngine()._drawCalls?.current,
        meshes: game.scene.meshes.length,
        activeMeshes: game.scene.getActiveMeshes().length,
        vertices: game.scene.getTotalVertices(),
      }),
      debug: local
        ? {
            teleport: (zone: string, x: number, z: number) => local.sim?.debugTeleport("local", zone, x, z),
            spawn: (species: string, level: number, distance = 6) => local.sim?.debugSpawn("local", species, level, distance),
            setHour: (h: number) => local.sim?.debugSetHour(h),
            addCreature: (species: string, level: number) => local.sim?.debugAddCreature("local", species, level),
            give: (item: string, n: number) => {
              const s = local.sim?.playerSave("local");
              if (s) s.inventory[item] = (s.inventory[item] ?? 0) + n;
            },
          }
        : null,
      net: () => game.connection,
    };
  }
}
