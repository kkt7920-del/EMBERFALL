import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Culling/ray";
import { Scene } from "@babylonjs/core/scene";
import { BATTLE_START_RANGE, CHUNK_SIZE, INTERACT_RANGE } from "@shared/config/constants";
import type { ContentDB } from "@shared/data/contentDb";
import { creatureName, statsOf } from "@shared/data/stats";
import { hashString } from "@shared/math/rng";
import { dist2 } from "@shared/math/vec";
import type { PlayerAction, ServerMessage } from "@shared/protocol/messages";
import type { NpcDef, RegionDef } from "@shared/types/content";
import type { PlayerPrivateState, PlayerSnapshot } from "@shared/types/game";
import { Block } from "@shared/world/blocks";
import { TerrainGenerator } from "@shared/world/generator";
import { VoxelWorld, chunkKey } from "@shared/world/voxelWorld";
import { OVERWORLD } from "@shared/world/zone";
import { Sky } from "../air/Sky";
import { BattleController } from "../battle/BattleController";
import { BallSystem } from "../capture/BallSystem";
import { CaptureFx } from "../capture/BallVisuals";
import { ThrowController } from "../capture/ThrowController";
import { TouchControls } from "../mobile/TouchControls";
import { Device } from "../mobile/Device";
import type { GameConnection } from "../network/Connection";
import type { LocalConnection } from "../network/LocalGameServer";
import { PokemonAssetRegistry } from "../pokemon/PokemonAssetRegistry";
import { PokemonLibrary } from "../pokemon/PokemonLibrary";
import { WildManager } from "../pokemon/WildManager";
import { Companion } from "../mount/MountVisual";
import { questHud } from "../quest/QuestTracker";
import { type ClientSettings, saveSettings, useTouchControls } from "../settings";
import { createTerrainMaterial, type TerrainMaterials } from "../terrain/TerrainMaterial";
import { BallHud, BallWheel } from "../ui/BallHud";
import { BattleUI } from "../ui/BattleUI";
import { Dialog } from "../ui/Dialog";
import { Hud } from "../ui/Hud";
import { closeModal, modalOpen } from "../ui/Modal";
import { Panels } from "../ui/panels";
import { openMenu } from "../ui/Menu";
import { ChunkManager } from "../world/ChunkManager";
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
const PHASE_LABEL: Record<string, string> = { DAWN: "새벽", DAY: "낮", AFTERNOON: "오후", SUNSET: "노을", NIGHT: "밤" };

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
  readonly voxels: VoxelWorld;
  chunks!: ChunkManager;
  terrainMats!: TerrainMaterials;
  sky!: Sky;
  cam!: CameraRig;
  input!: Input;
  touch: TouchControls | null = null;
  hud!: Hud;
  ballHud!: BallHud;
  wheel!: BallWheel;
  dialog!: Dialog;
  panels!: Panels;
  battleUI!: BattleUI;
  battle!: BattleController;
  effects!: Effects;
  captureFx!: CaptureFx;
  assets: PokemonAssetRegistry;
  pokemon!: PokemonLibrary;
  creatures!: WildManager;
  balls!: BallSystem;
  thrower!: ThrowController;
  companion!: Companion;
  shadows: ShadowGenerator | null = null;
  readonly sfx = new Sfx();

  readonly controller = new PlayerController();
  playerAvatar!: Avatar;
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
  private deferredDespawn: string[] = [];
  private talkingTo: string | null = null;
  private disposed = false;
  private frameTimes: number[] = [];
  lastDrawCalls = 0;
  /** [game logic ms, scene.render ms (CPU side)] per frame, for the perf overlay and tests. */
  cpuTimes: [number, number][] = [];
  private lastFrame = performance.now();
  private netStatus = "";
  private mapImage: Promise<ImageData> | null = null;
  private time = 0;

  private constructor(private readonly opts: GameOptions) {
    this.db = opts.db;
    this.region = opts.db.defaultRegion();
    this.voxels = new VoxelWorld(new TerrainGenerator(this.region), 220);
    this.assets = new PokemonAssetRegistry(opts.db);
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

    progress(0.08, "그래픽 엔진 준비 중…");
    const info = await createEngine(canvas, settings.renderer === "webgpu");
    this.engine = info.engine;
    this.engineKind = info.kind;
    this.applyResolution();
    await this.assets.init();

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
    this.sky.setViewDistance(this.viewDistance(settings));
    this.terrainMats = createTerrainMaterial(scene);
    this.chunks = new ChunkManager(scene, this.terrainMats, this.region, settings, this.voxels);
    this.effects = new Effects(scene, settings.particleBudget);
    this.captureFx = new CaptureFx(scene, settings.particleBudget);
    this.pokemon = new PokemonLibrary(scene, this.db, this.assets);
    this.creatures = new WildManager(this.pokemon);
    this.companion = new Companion(this.pokemon, this.voxels);

    this.avatarMat = new StandardMaterial("avatarMat", scene);
    this.avatarMat.specularColor = Color3.Black();
    this.playerAvatar = new Avatar(scene, this.avatarMat, PLAYER_LOOK, "player");
    this.setupShadows();

    // UI
    this.hud = new Hud(ui);
    this.hud.onAction = (a) => this.input.press(a);
    this.ballHud = new BallHud(ui, this.db);
    this.wheel = new BallWheel(ui, this.db);
    this.dialog = new Dialog(ui);
    this.battleUI = new BattleUI(ui, this.db);
    this.panels = new Panels({
      db: this.db,
      region: this.region,
      assets: this.assets,
      state: () => this.state,
      send: (a) => this.action(a),
      equipBall: (id) => {
        this.thrower.select(id);
        this.thrower.setEquipped(true);
      },
    });

    this.input = new Input(canvas);
    this.input.sensitivity = settings.cameraSensitivity;
    this.input.invertY = settings.invertY;
    this.input.pointerLockAllowed = !Device.touch;
    if (useTouchControls(settings)) this.createTouch();
    this.hud.setKeyHints(!this.touch);
    this.sfx.vibration = settings.vibration !== false;

    this.balls = new BallSystem(scene, this.db, this.voxels, this.creatures, this.captureFx, this.sfx, this.cam, {
      selfId: () => this.selfId,
      playerHand: () => this.controller.pos.add(new Vector3(0, 1.3, 0)),
      speciesName: (id) => this.db.species.get(id)?.name ?? id,
      gotcha: (title, sub) => this.ballHud.gotcha(title, sub),
      toast: (text, tone) => this.hud.toast(text, tone),
    });
    this.thrower = new ThrowController({
      db: this.db,
      world: this.voxels,
      state: () => this.state,
      cam: this.cam,
      controller: this.controller,
      avatar: this.playerAvatar,
      balls: this.balls,
      wild: this.creatures,
      hud: this.ballHud,
      sfx: this.sfx,
      send: (m) => this.connection.send(m),
      toast: (t, tone) => this.hud.toast(t, tone),
      keyHints: () => !this.touch,
    });
    this.ballHud.onChip = () => this.openWheel();
    this.ballHud.onPick = (id) => {
      this.thrower.select(id);
      this.thrower.setEquipped(true);
    };

    this.battle = new BattleController({
      db: this.db,
      ui: this.battleUI,
      panels: this.panels,
      camera: this.cam,
      effects: this.effects,
      lib: this.pokemon,
      creatures: this.creatures,
      world: this.voxels,
      playerPos: () => this.controller.pos.clone(),
      playerRot: () => this.controller.rotY,
      state: () => this.state,
      send: (battleId, action) => this.connection.send({ type: "BATTLE_ACTION", battleId, action }),
      onStart: () => this.input.releasePointerLock(),
      onEnd: () => this.input.releasePointerLock(),
      setFollowerHidden: (on) => this.companion.hide(on),
      sfx: (n) => this.sfx.play(n),
      startCatch: (foeId, onThrown, onCancel) => {
        this.wheel.show(
          this.thrower.allBalls(),
          this.thrower.selected,
          (id) => {
            const foe = this.creatures.get(foeId);
            if (foe) this.cam.yaw = Math.atan2(foe.view.root.position.x - this.controller.pos.x, foe.view.root.position.z - this.controller.pos.z);
            this.cam.pitch = 0.18;
            this.touch?.setAimOnly(true);
            this.thrower.enterBattleAim(foeId, id, () => {
              this.touch?.setAimOnly(false);
              onThrown();
            }, () => {
              this.touch?.setAimOnly(false);
              onCancel();
            });
          },
          { title: "던질 볼을 고르세요", onClose: onCancel },
        );
      },
    });

    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    canvas.addEventListener("pointerdown", () => this.sfx.unlock(), { once: true });
    window.addEventListener("keydown", () => this.sfx.unlock(), { once: true });
    this.sfx.enabled = settings.sound;

    // Network (single player shares this voxel store with the local server)
    progress(0.3, this.connection.mode === "online" ? "서버에 접속 중…" : "월드를 불러오는 중…");
    (this.connection as Partial<LocalConnection>).setVoxels?.(this.voxels);
    this.connection.onMessage = (m) => this.onMessage(m);
    this.connection.onStatus = (s, detail) => this.onNetStatus(s, detail);
    await this.connection.connect(this.opts.name);
    await new Promise<void>((resolve) => (this.welcomed ? resolve() : this.welcomeWaiters.push(resolve)));

    progress(0.55, "지형 생성 중…");
    await new Promise<void>((resolve) => {
      this.chunks.onReady = resolve;
      const pump = () => {
        if (this.disposed) return resolve();
        this.chunks.update(this.controller.pos.x, this.controller.pos.z);
        const loaded = this.chunks.loadedCount;
        const total = (this.settings.chunkRadius * 2 + 1) ** 2;
        progress(0.55 + 0.4 * Math.min(1, loaded / total), `지형 생성 중… ${loaded}/${total}`);
        if (this.chunks.onReady) requestAnimationFrame(pump);
      };
      pump();
    });
    progress(1, "준비 완료");

    this.engine.runRenderLoop(() => this.frame());
    this.exposeDebug();
  }

  private createTouch(): void {
    this.touch = new TouchControls(this.opts.ui, this.input);
    this.opts.ui.insertBefore(this.touch.el, this.opts.ui.firstChild);
    this.opts.ui.classList.add("is-touch");
    this.touch.ballEquipped = () => this.thrower?.equipped ?? false;
    this.touch.onEquip = () => this.thrower.setEquipped(true);
  }

  private viewDistance(s: ClientSettings): number {
    return (s.lodTiles + 0.4) * 128;
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
    light.shadowMaxZ = 260;
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
    this.sky.setViewDistance(this.viewDistance(next));
    if (prev.particleBudget !== next.particleBudget) {
      this.sky.setParticleBudget(next.particleBudget);
      this.effects.setBudget(next.particleBudget);
      this.captureFx.setBudget(next.particleBudget);
    }
    if (prev.shadows !== next.shadows || prev.chunkRadius !== next.chunkRadius || prev.vegetationRadius !== next.vegetationRadius || prev.lodTiles !== next.lodTiles) {
      this.setupShadows();
      this.chunks.reset();
    }
    this.input.sensitivity = next.cameraSensitivity;
    this.input.invertY = next.invertY;
    this.sfx.enabled = next.sound;
    this.sfx.vibration = next.vibration !== false;
    const wantTouch = useTouchControls(next);
    if (wantTouch && !this.touch) this.createTouch();
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
          this.balls.clear();
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
        this.controller.teleport(m.x, m.y, m.z, m.rotY);
        this.lastSent = { ...this.lastSent, x: m.x, y: m.y, z: m.z };
        if (m.reason === "teleport") {
          if (m.rotY !== undefined) this.cam.yaw = m.rotY;
          this.cam.snap();
        }
        break;
      case "POKEMON_SPAWN":
        this.creatures.spawn(m.creatures);
        break;
      case "POKEMON_DESPAWN": {
        const now: string[] = [];
        for (const id of m.ids) {
          if (this.balls.busy.has(id)) {
            const reason = m.reason;
            void this.balls.whenDone(id).then(() => this.creatures.despawn([id], reason));
          } else if (this.battle.view?.entityId === id && m.reason !== "defeated" && m.reason !== "captured") this.deferredDespawn.push(id);
          else now.push(id);
        }
        this.creatures.despawn(now, m.reason);
        break;
      }
      case "POKEMON_MOVE":
        this.creatures.move(m.creatures.filter((c) => !this.balls.busy.has(c.id)));
        break;
      case "BALL_SPAWN":
        if (m.ball.owner === this.selfId) this.thrower.confirm(m.ball.seq);
        this.balls.onSpawn(m.ball);
        break;
      case "BALL_UPDATE":
        if (m.id.startsWith("seq:")) this.thrower.confirm(Number(m.id.slice(4)));
        this.balls.onUpdate(m);
        break;
      case "CAPTURE_SEQUENCE":
        void this.balls.playSequence(m);
        break;
      case "CAPTURE_RESULT":
        if (m.success && m.creature) {
          const name = creatureName(this.db, m.creature);
          const where = m.sentTo === "box" ? "PC 보관함으로 보냈다" : "파티에 들어왔다";
          void this.balls.whenDone(m.targetId).then(() => {
            this.hud.toast(`${name}이(가) ${where}!${m.newSpecies ? " (도감에 새로 등록)" : ""}`, "good");
          });
        }
        break;
      case "BATTLE_START":
        this.thrower.setEquipped(false);
        this.sequencer = this.sequencer.then(() => this.battle.start(m.battle));
        break;
      case "BATTLE_RESULT":
        // Let a running capture animation finish before the battle log continues
        this.sequencer = this.sequencer.then(() => (m.battle.entityId ? this.balls.whenDone(m.battle.entityId) : undefined)).then(() => this.battle.result(m));
        if (m.outcome) this.sequencer = this.sequencer.then(() => this.flushDeferred());
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
    this.zone = zone;
    if (this.npcs.size) return;
    for (const def of this.region.npcs) {
      const avatar = new Avatar(this.scene, this.avatarMat, def.look, `npc_${def.id}`);
      const y = def.y ?? this.voxels.topSolid(def.x + 0.5, def.z + 0.5) + 1;
      avatar.root.position.set(def.x + 0.5, y, def.z + 0.5);
      avatar.root.rotation.y = def.facing;
      createNameTag(this.scene, def.name, avatar.root);
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
      this.companion.set(mount?.species ?? null, "mount", mount?.size ?? 1);
    } else {
      this.controller.mountModes = [];
      this.controller.mountSpeed = 1;
      this.companion.set(lead?.species ?? null, "follow", lead?.size ?? 1);
    }
  }

  private addRemote(p: PlayerSnapshot): void {
    if (this.remotes.has(p.id) || p.id === this.selfId) return;
    const h = hashString(p.id);
    const look: AvatarLook = { skin: "#f0c8a0", hair: h % 2 ? "#2a2a2a" : "#8a5a2a", shirt: SHIRTS[h % SHIRTS.length], pants: "#2e3a5a" };
    const avatar = new Avatar(this.scene, this.avatarMat, look, `remote_${p.id}`);
    avatar.root.position.set(p.x, p.y, p.z);
    createNameTag(this.scene, p.name, avatar.root);
    const companion = new Companion(this.pokemon, this.voxels);
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
    this.time += dt;

    const battleAim = this.battle.aiming || this.thrower.battleAim !== null;
    const busy = this.dialog.open || modalOpen() || (this.battle.active && !battleAim) || !this.welcomed || this.wheel.open;
    this.input.gameplayEnabled = !busy;
    this.input.ballMode = this.thrower.equipped && !busy;
    this.touch?.setGameplay(!busy || battleAim);
    const controls = this.input.frame();
    this.handleActions(controls, busy);

    const freeMove = !this.battle.active;
    if (freeMove) this.controller.update(dt, controls, this.cam.yaw, this.voxels);
    else if (battleAim) this.controller.rotY = this.cam.yaw;
    this.thrower.update(dt, controls, (!busy && !this.battle.active) || battleAim, !this.battle.active);

    // Player avatar (+ ridden Pokémon)
    const seat = this.companion.seat;
    const pos = this.controller.pos;
    this.playerAvatar.root.position.set(pos.x, pos.y + seat, pos.z);
    this.playerAvatar.root.rotation.y = this.controller.rotY;
    this.playerAvatar.pose = this.controller.mounted ? "sit" : this.controller.anim;
    this.playerAvatar.update(dt);
    if (!this.battle.active) this.companion.update(dt, pos, this.controller.rotY, this.controller.anim);

    this.sendMovement(now);

    const fwd = this.cam.forward();
    this.chunks.update(pos.x, pos.z, fwd.x, fwd.z);
    this.creatures.update(dt, this.cam.camera.position, this.settings.creatureViewDistance);
    this.balls.update(dt, pos);
    this.battle.update(dt);
    this.updateRemotes(dt);
    this.updateNpcs(dt);

    if (now - this.lastTargetScan > 100) {
      this.lastTargetScan = now;
      this.scanTarget();
    }
    this.updatePromptAndTag(busy);

    this.cam.update(dt, this.playerAvatar.root.position, controls, this.voxels);
    this.updateEnvironment(pos);
    this.sky.update(dt, pos, this.cam.camera.position);

    if (now - this.lastHud > 250) {
      this.lastHud = now;
      this.updateHud();
    }
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (this.settings.showFps) this.hud.setFps(this.frameTimes.length / this.frameTimes.reduce((a, b) => a + b, 0));
    else this.hud.setFps(null);

    const logicEnd = performance.now();
    this.scene.render();
    this.cpuTimes.push([logicEnd - now, performance.now() - logicEnd]);
    if (this.cpuTimes.length > 120) this.cpuTimes.shift();
    // Babylon's draw-call counter only resets when instrumentation fetches a frame
    const dc = (this.engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } })._drawCalls;
    if (dc) {
      this.lastDrawCalls = dc.current;
      dc.fetchNewFrame();
    }
  }

  /** Underground / underwater detection, lantern, and terrain shader uniforms. */
  private updateEnvironment(pos: Vector3): void {
    const v = this.voxels;
    const cam = this.cam.camera.position;
    const surface = v.peekChunk(Math.floor(pos.x / CHUNK_SIZE), Math.floor(pos.z / CHUNK_SIZE)) ? v.surfaceHeight(pos.x, pos.z) : 999;
    const underground = pos.y < surface - 4 && !v.skyVisible(pos.x, pos.y + 2, pos.z);
    this.sky.setUnderground(underground);
    let depth: number | null = null;
    if (v.block(cam.x, cam.y, cam.z) === Block.WATER) {
      let top = Math.floor(cam.y);
      while (v.block(cam.x, top + 1, cam.z) === Block.WATER && top < 255) top++;
      depth = top + 1 - cam.y;
    }
    this.sky.setUnderwater(depth);
    const u = this.terrainMats.uniforms;
    u.time = this.time;
    const night = this.sky.phase === "NIGHT";
    const lantern = underground ? 11 : night ? 7 : 0;
    u.light = [pos.x, pos.y + 1.6, pos.z, lantern];
    u.ambientFloor = underground ? 0.1 : 0.16;
  }

  private openWheel(): void {
    if (this.wheel.open) return;
    this.input.releasePointerLock();
    this.wheel.show(
      this.thrower.allBalls(),
      this.thrower.selected,
      (id) => {
        this.thrower.select(id);
        this.thrower.setEquipped(true);
      },
      { onPutAway: this.thrower.equipped ? () => this.thrower.setEquipped(false) : undefined },
    );
  }

  private handleActions(c: { pressed: Set<Action>; longPress: { x: number; y: number } | null }, busy: boolean): void {
    for (const a of c.pressed) {
      if (a === "close") {
        if (this.wheel.open) this.wheel.close();
        else if (modalOpen()) closeModal();
        else if (this.thrower.battleAim) this.thrower.cancelBattleAim();
        else if (this.thrower.equipped) this.thrower.setEquipped(false);
        continue;
      }
      if (this.battle.active || this.dialog.open) continue;
      if (a === "party" || a === "bag" || a === "map" || a === "menu" || a === "dex") {
        this.input.releasePointerLock();
        if (modalOpen()) {
          closeModal();
          continue;
        }
        if (a === "party") this.panels.party();
        else if (a === "bag") this.panels.bag();
        else if (a === "map") this.openMap();
        else if (a === "dex") this.panels.pokedex();
        else openMenu(this);
        continue;
      }
      if (busy) continue;
      if (a === "wheel") this.openWheel();
      else if (a === "interact") this.interact();
      else if (a === "attack") this.startBattle();
      else if (a === "mount") this.action({ kind: "mount", on: !this.state?.mounted });
    }
    if (c.longPress && !busy && !this.battle.active) this.pickAt(c.longPress.x, c.longPress.y);
  }

  /** Long-press on a Pokémon (touch): quick info. */
  private pickAt(x: number, y: number): void {
    // CSS pixels: Babylon applies the hardware scaling level itself
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.cam.camera);
    let best: string | null = null;
    let bestT = Infinity;
    for (const w of this.creatures.all()) {
      if (!w.view.root.isEnabled()) continue;
      const p = w.view.root.position;
      const hw = Math.max(0.5, w.view.width / 2 + 0.2);
      const t = rayAabb(ray.origin, ray.direction, p.x - hw, p.y, p.z - hw, p.x + hw, p.y + Math.max(0.8, w.view.height + 0.2), p.z + hw);
      if (t !== null && t < bestT && t < 40) {
        bestT = t;
        best = w.snap.id;
      }
    }
    if (best) this.showWildInfo(best);
  }

  private showWildInfo(id: string): void {
    const w = this.creatures.get(id);
    if (!w) return;
    this.input.releasePointerLock();
    const near = Vector3.Distance(this.controller.pos, w.view.root.position) < BATTLE_START_RANGE + 1 + w.view.width / 2;
    this.panels.wildInfo(w.snap, near && !w.snap.special ? () => this.action({ kind: "battle", target: id }) : undefined);
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
      r.companion.update(dt, new Vector3(base.x, r.target.y, base.z), root.rotation.y, r.snap.anim);
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
      } else a.pose = "idle";
      a.update(dt);
    }
  }

  // ------------------------------------------------------------------ interaction

  private objectY(o: { x: number; z: number; y?: number }): number {
    return o.y !== undefined ? o.y + 1 : this.voxels.topSolid(o.x + 0.5, o.z + 0.5) + 1;
  }

  private scanTarget(): void {
    const p = this.controller.pos;
    let best: Target | null = null;
    let bestD = INTERACT_RANGE;
    for (const n of this.npcs.values()) {
      const d = dist2(p.x, p.z, n.def.x + 0.5, n.def.z + 0.5);
      if (d < bestD && Math.abs(n.avatar.root.position.y - p.y) < 4) {
        bestD = d;
        const verb = n.def.role === "trainer" ? "에게 말 걸기" : n.def.role === "clerk" ? "(상점)" : n.def.role === "nurse" ? "(회복)" : "와(과) 대화";
        best = { kind: "npc", id: n.def.id, label: `${n.def.name}${verb}`, pos: n.avatar.root.position.add(new Vector3(0, 2.2, 0)) };
      }
    }
    for (const it of this.region.interactables) {
      const d = dist2(p.x, p.z, it.x + 0.5, it.z + 0.5);
      const y = this.objectY(it);
      if (Math.abs(y - p.y) > 5) continue;
      const range = it.kind === "altar" ? INTERACT_RANGE + 1.5 : INTERACT_RANGE;
      if (d < Math.min(bestD + 0.01, range) || (d < range && !best)) {
        bestD = d;
        const verb: Record<string, string> = { sign: "읽기", crystal: "조사하기", tablet: "조사하기", altar: "조사하기" };
        best = { kind: "object", id: it.id, label: `${it.name} ${verb[it.kind] ?? "조사하기"}`, pos: new Vector3(it.x + 0.5, y + 1.5, it.z + 0.5) };
      }
    }
    if (!best) {
      const w = this.creatures.nearest(p, BATTLE_START_RANGE, (e) => e.view.root.isEnabled());
      if (w) {
        const s = this.db.species.get(w.snap.species)!;
        best = { kind: "wild", id: w.snap.id, label: `야생 ${s.name} Lv.${w.snap.level} — 정보`, pos: w.view.root.position.add(new Vector3(0, w.view.height + 0.3, 0)) };
      }
    }
    this.target = best;
  }

  private updatePromptAndTag(busy: boolean): void {
    const t = busy || this.thrower.equipped ? null : this.target;
    this.hud.showPrompt(t ? t.label : null, this.touch ? "A" : "E");

    // Floating name over the nearest wild Pokémon (not while aiming: the reticle shows it)
    let tag: { pos: Vector3; text: string } | null = null;
    if (!busy && !this.thrower.equipped) {
      const w = this.creatures.nearest(this.controller.pos, 18, (e) => e.view.root.isEnabled());
      if (w) {
        const s = this.db.species.get(w.snap.species)!;
        tag = { pos: w.view.root.position.add(new Vector3(0, w.view.height + 0.35, 0)), text: `${s.name} Lv.${w.snap.level}${w.snap.alpha ? " ★" : ""}` };
      }
    }
    if (tag) {
      const engine = this.engine;
      const v = Vector3.Project(tag.pos, Matrix.Identity(), this.scene.getTransformMatrix(), this.cam.camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()));
      const scale = engine.getHardwareScalingLevel();
      if (v.z > 0 && v.z < 1) this.hud.showTarget(v.x * scale, v.y * scale, tag.text, true);
      else this.hud.showTarget(0, 0, null, true);
    } else this.hud.showTarget(0, 0, null, true);

    // Ground balls nearby: hint to pick them up
    const lying = this.balls.resting().filter((b) => b.mine);
    let hint: string | null = null;
    for (const b of lying) {
      const d = Math.hypot(b.x - this.controller.pos.x, b.y - this.controller.pos.y, b.z - this.controller.pos.z);
      if (d < 14) {
        hint = `떨어진 볼 ${d.toFixed(0)}m — 다가가면 줍는다`;
        break;
      }
    }
    this.ballHud.setHint(busy ? null : hint);
    // In battle the menu owns the bottom right until "포획" puts a ball in hand
    this.ballHud.setVisible(!this.battle.active || !!this.thrower.battleAim);
  }

  private interact(): void {
    const t = this.target;
    if (!t) return;
    if (t.kind === "wild") this.showWildInfo(t.id);
    else this.action({ kind: "interact", target: t.id });
  }

  private startBattle(): void {
    const w = this.creatures.nearest(this.controller.pos, BATTLE_START_RANGE + 1.5, (e) => e.view.root.isEnabled());
    if (!w) {
      this.hud.toast("근처에 배틀할 야생 포켓몬이 없다. 가까이 다가가자!", "bad");
      return;
    }
    this.action({ kind: "battle", target: w.snap.id });
  }

  // ------------------------------------------------------------------ HUD

  private updateHud(): void {
    const st = this.state;
    const p = this.controller.pos;
    const areas = this.region.areas
      .filter((a) => dist2(p.x, p.z, a.x, a.z) <= a.radius && (a.minY === undefined || p.y >= a.minY) && (a.maxY === undefined || p.y <= a.maxY))
      .sort((a, b) => a.radius - b.radius);
    const biome = this.voxels.peekChunk(Math.floor(p.x / CHUNK_SIZE), Math.floor(p.z / CHUNK_SIZE)) ? this.voxels.biomeAt(p.x, p.y, p.z) : "";
    this.hud.setLocation(areas[0]?.name ?? this.region.name, biome);
    const hour = this.sky.hour;
    const hh = Math.floor(hour);
    const mm = Math.floor((hour - hh) * 60);
    const icon = hour >= 6 && hour < 18 ? "🌤" : "🌙";
    this.hud.setMeta(`${icon} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} ${PHASE_LABEL[this.sky.phase]}`, this.sky.isUnderground ? "⛏ 지하" : WEATHER_LABEL[this.sky.weather], st?.money ?? 0);
    const lead = st?.party[0];
    if (lead) {
      const s = this.db.speciesOf(lead);
      this.hud.setLead({ name: creatureName(this.db, lead), level: lead.level, hp: lead.hp, maxHp: statsOf(this.db, lead).hp, color: this.db.typeColor(s.types[0]) });
    } else this.hud.setLead(null);
    this.hud.setQuest(st ? questHud(this.db, st) : "");
    this.hud.setNet(this.netStatus);
  }

  openMap(): void {
    const b = this.region.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    const scale = Math.ceil(span / 320);
    const size = Math.ceil(span / scale);
    if (!this.mapImage) this.mapImage = this.chunks.requestMap(b.minX, b.minZ, size, scale);
    const p = this.controller.pos;
    this.panels.map({ image: this.mapImage, bounds: { minX: b.minX, minZ: b.minZ, span: size * scale }, player: { x: p.x, z: p.z, rotY: this.controller.rotY } });
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
      get pitch() {
        return game.cam.pitch;
      },
      set pitch(v: number) {
        game.cam.pitch = v;
      },
      get battle() {
        return game.battle.view;
      },
      get target() {
        return game.target;
      },
      get chunks() {
        return { loaded: game.chunks.loadedCount, total: game.chunks.chunkCount, far: game.chunks.farCount, voxels: game.voxels.size, buildMs: game.chunks.buildTimes.slice(-10) };
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
      get aim() {
        const t = game.thrower.target;
        return { equipped: game.thrower.equipped, selected: game.thrower.selected, target: t ? t.snap.id : null, battleAim: !!game.thrower.battleAim, last: game.thrower.lastThrow, camYaw: game.cam.yaw, forward: game.cam.forward().asArray() };
      },
      get sounds() {
        return [...game.sfx.log];
      },
      balls: () => ({ flying: game.balls.flying(), resting: game.balls.resting(), busy: [...game.balls.busy] }),
      creatures: () =>
        [...game.creatures.all()].map((w) => ({
          ...w.snap,
          x: w.view.root.position.x,
          y: w.view.root.position.y,
          z: w.view.root.position.z,
          visible: w.view.root.isEnabled(),
          held: w.held,
          asset: w.view.status,
          body: w.view.body.kind,
          height: w.view.height,
        })),
      assets: () => game.assets.report(),
      block: (x: number, y: number, z: number) => game.voxels.block(x, y, z),
      biome: (x: number, y: number, z: number) => game.voxels.biomeAt(x, y, z),
      column: (x: number, z: number) => {
        const c = game.voxels.gen.column(x, z);
        return { ...c };
      },
      stats: () => ({
        fps: game.engine.getFps(),
        drawCalls: game.lastDrawCalls,
        meshes: game.scene.meshes.length,
        activeMeshes: game.scene.getActiveMeshes().length,
        vertices: game.scene.getTotalVertices(),
        terrainMeshes: game.chunks.drawnMeshes(),
        frameMs: (game.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, game.frameTimes.length)) * 1000,
        logicMs: game.cpuTimes.reduce((a, b) => a + b[0], 0) / Math.max(1, game.cpuTimes.length),
        logicMsP95: [...game.cpuTimes.map((c) => c[0])].sort((a, b) => a - b)[Math.floor(game.cpuTimes.length * 0.95)] ?? 0,
        renderCpuMs: game.cpuTimes.reduce((a, b) => a + b[1], 0) / Math.max(1, game.cpuTimes.length),
      }),
      pinned: () => [...game.voxels["pinned" as never] as unknown as Set<number>].length,
      chunkKey,
      debug: local
        ? {
            teleport: (x: number, z: number, y?: number) => local.sim?.debugTeleport("local", x, z, y),
            spawn: (species: string, level: number, distance = 6, opts: { alpha?: boolean; hpFraction?: number } = {}) => local.sim?.debugSpawn("local", species, level, distance, opts),
            setHour: (h: number) => local.sim?.debugSetHour(h),
            addCreature: (species: string, level: number) => local.sim?.debugAddCreature("local", species, level),
            give: (item: string, n: number) => local.sim?.debugGive("local", item, n),
            forceCapture: (o: "success" | "fail" | "critical" | null) => local.sim?.debugForceCapture(o),
            serverCreatures: () => local.sim?.creaturesNear("local") ?? [],
            serverBalls: () => local.sim?.ballsNear("local") ?? [],
            inspect: () => local.sim?.inspect(),
          }
        : null,
      net: () => game.connection,
    };
  }
}

function rayAabb(o: Vector3, d: Vector3, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number | null {
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
