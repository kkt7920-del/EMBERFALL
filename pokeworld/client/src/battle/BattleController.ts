import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { ContentDB } from "@shared/data/contentDb";
import { creatureName, expForLevel, statsOf } from "@shared/data/stats";
import type { ServerMessageOf } from "@shared/protocol/messages";
import type { BattleAction, BattleCreatureView, BattleEvent, BattleView } from "@shared/types/battle";
import type { CreatureInstance, PlayerPrivateState } from "@shared/types/game";
import type { VoxelWorld } from "@shared/world/voxelWorld";
import type { CameraRig } from "../engine/CameraRig";
import type { Effects } from "../engine/Effects";
import type { SoundEvent } from "../engine/Audio";
import type { PokemonLibrary } from "../pokemon/PokemonLibrary";
import type { PokemonView } from "../pokemon/PokemonView";
import type { WildManager } from "../pokemon/WildManager";
import type { BattleUI } from "../ui/BattleUI";
import type { Panels } from "../ui/panels";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BattleHost {
  db: ContentDB;
  ui: BattleUI;
  panels: Panels;
  camera: CameraRig;
  effects: Effects;
  lib: PokemonLibrary;
  creatures: WildManager;
  world: VoxelWorld;
  playerPos(): Vector3;
  playerRot(): number;
  state(): PlayerPrivateState | null;
  send(battleId: string, action: BattleAction): void;
  onStart(): void;
  onEnd(outcome: string | undefined): void;
  setFollowerHidden(on: boolean): void;
  sfx(name: SoundEvent): void;
  /** Battle "포획": choose a ball, then aim and throw it for real. */
  startCatch(foeId: string, onThrown: () => void, onCancel: () => void): void;
}

/**
 * Presents a server-run battle in the open world: the partner steps out next
 * to the trainer, the camera frames both Pokémon (the same models used in the
 * field), and server events are played back in order. Capturing is a real
 * throw: the menu hands control to the aim mode, the server simulates the
 * ball, and the battle continues with the result.
 */
export class BattleController {
  view: BattleView | null = null;
  private mine: PokemonView | null = null;
  private foe: PokemonView | null = null;
  private ownsFoeView = false;
  private queue: Promise<void> = Promise.resolve();
  private awaitingServer = false;
  private minePos = new Vector3();
  private foePos = new Vector3();
  /** True while the player aims/throws a ball (menu hidden). */
  aiming = false;

  constructor(private readonly host: BattleHost) {}

  get active(): boolean {
    return this.view !== null;
  }

  start(view: BattleView): Promise<void> {
    this.queue = this.queue.then(() => this.doStart(view));
    return this.queue;
  }

  result(msg: ServerMessageOf<"BATTLE_RESULT">): void {
    this.queue = this.queue.then(() => this.doResult(msg)).catch((e) => console.error(e));
  }

  private groundAt(x: number, y: number, z: number): number {
    return this.host.world.floorNear(x, y + 2, z, 1, 3, 8) ?? y;
  }

  private async doStart(view: BattleView): Promise<void> {
    const { db, ui } = this.host;
    this.view = view;
    this.host.onStart();
    this.host.setFollowerHidden(true);

    const player = this.host.playerPos();
    const entity = view.entityId ? this.host.creatures.get(view.entityId) : undefined;

    // Foe: the wild Pokémon where it stands, otherwise in front of the trainer
    if (entity) {
      entity.pinned = true;
      this.foe = entity.view;
      this.ownsFoeView = false;
      this.foePos.copyFrom(entity.view.root.position);
    } else {
      const r = this.host.playerRot();
      const fx = player.x + Math.sin(r) * 7;
      const fz = player.z + Math.cos(r) * 7;
      this.foe = this.host.lib.acquire(view.foe.species, { size: view.foe.size, alpha: view.foe.alpha });
      this.ownsFoeView = true;
      this.foePos.set(fx, this.groundAt(fx, player.y, fz), fz);
      this.foe.root.position.copyFrom(this.foePos);
    }

    const toFoe = this.foePos.subtract(player);
    toFoe.y = 0;
    const dist = Math.max(3, toFoe.length());
    toFoe.normalize();
    const side = new Vector3(toFoe.z, 0, -toFoe.x);
    const mx = player.x + toFoe.x * Math.min(2.6, dist * 0.4) + side.x * 1.2;
    const mz = player.z + toFoe.z * Math.min(2.6, dist * 0.4) + side.z * 1.2;
    this.minePos.set(mx, this.groundAt(mx, player.y, mz), mz);
    this.spawnMine(view.party[view.activeIndex]);

    this.faceEachOther();
    this.foe.anim = "battle";
    this.host.camera.setBattle(this.minePos, this.foePos);

    ui.show(true);
    ui.hideMenu();
    ui.setFoe(view.foe, view.kind === "wild" || view.kind === "legendary");
    this.refreshMine();

    const intro =
      view.kind === "trainer"
        ? `${view.trainer}이(가) 승부를 걸어왔다!`
        : view.kind === "guardian"
          ? `${view.foe.name}이(가) 길을 막아섰다!`
          : view.kind === "legendary"
            ? `전설의 포켓몬 ${view.foe.name}이(가) 모습을 드러냈다!`
            : `야생 ${view.foe.name}${view.foe.alpha ? "(알파)" : ""}이(가) 나타났다!`;
    ui.say(intro);
    await ui.waitTap(1300);
    const me = view.party[view.activeIndex];
    ui.say(`가랏, ${creatureName(db, me)}!`);
    this.host.effects.sparks(this.minePos.add(new Vector3(0, 0.6, 0)), "#ffffff", 18);
    await ui.waitTap(900);
    this.showMenu();
  }

  private spawnMine(c: CreatureInstance): void {
    if (this.mine) this.host.lib.release(this.mine);
    this.mine = this.host.lib.acquire(c.species, { size: c.size, alpha: c.alpha });
    this.mine.root.position.copyFrom(this.minePos);
    this.mine.anim = "battle";
  }

  private faceEachOther(): void {
    if (!this.mine || !this.foe) return;
    const a = this.minePos;
    const b = this.foePos;
    this.mine.root.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    this.foe.root.rotation.y = Math.atan2(a.x - b.x, a.z - b.z);
  }

  private refreshMine(): void {
    const v = this.view;
    if (!v) return;
    const c = v.party[v.activeIndex];
    const max = statsOf(this.host.db, c).hp;
    const from = expForLevel(c.level);
    const to = expForLevel(c.level + 1);
    const plate: BattleCreatureView = {
      uid: c.uid,
      species: c.species,
      name: creatureName(this.host.db, c),
      level: c.level,
      hp: c.hp,
      maxHp: max,
      gender: c.gender,
      status: c.status,
      alpha: c.alpha,
      size: c.size,
    };
    this.host.ui.setMine(plate, (c.exp - from) / Math.max(1, to - from));
  }

  private ballCount(): number {
    const st = this.host.state();
    if (!st) return 0;
    return Object.entries(st.inventory).reduce((n, [id, k]) => n + (this.host.db.items.get(id)?.kind === "capture" ? k : 0), 0);
  }

  private showMenu(): void {
    const v = this.view;
    if (!v) return;
    const { ui, panels, db } = this.host;
    if (v.awaiting === "switch") {
      ui.say("다음으로 내보낼 포켓몬을 고르자!");
      ui.hideMenu();
      this.forceSwitch();
      return;
    }
    const me = v.party[v.activeIndex];
    ui.say(`${creatureName(db, me)}은(는) 무엇을 할까?`);
    ui.rootMenu(
      {
        fight: (i) => this.act({ kind: "move", index: i }),
        capture: () => this.beginCatch(),
        bag: () =>
          panels.bag({
            inBattle: true,
            onHeal: (item) => panels.party({ title: "누구에게 쓸까?", pickLabel: "사용", pick: (i) => this.act({ kind: "item", item, target: i }) }),
          }),
        party: () =>
          panels.party({
            title: "교체할 포켓몬",
            pickLabel: "교체",
            canPick: (c, i) => c.hp > 0 && i !== v.activeIndex,
            pick: (i) => this.act({ kind: "switch", index: i }),
          }),
        run: () => this.act({ kind: "run" }),
      },
      { canCapture: v.canCapture, canRun: v.canRun, moves: me.moves, orbs: this.ballCount() },
    );
  }

  /** Catch: choose a ball, aim at the opponent and throw it (the menu returns if cancelled). */
  private beginCatch(): void {
    const v = this.view;
    if (!v?.entityId || this.awaitingServer) return;
    this.aiming = true;
    this.host.ui.hideMenu();
    this.host.ui.setAiming(true);
    this.host.ui.say("볼을 골라 상대를 조준해서 던지자!");
    this.host.startCatch(
      v.entityId,
      () => {
        // Thrown: the turn resolves when the server finishes the capture (or the ball lands)
        this.aiming = false;
        this.awaitingServer = true;
        this.host.ui.setAiming(false);
        this.host.ui.say("…");
      },
      () => {
        this.aiming = false;
        this.host.ui.setAiming(false);
        this.showMenu();
      },
    );
  }

  private forceSwitch(): void {
    const v = this.view;
    if (!v) return;
    this.host.panels.custom(
      "다음 포켓몬을 고르세요",
      (body) => {
        const st = this.host.state();
        const party = st?.party ?? v.party;
        body.append(
          ...party.map((c, i) => {
            const b = document.createElement("button");
            b.className = "btn";
            b.style.width = "100%";
            b.style.marginBottom = "6px";
            b.disabled = c.hp <= 0;
            b.textContent = `${creatureName(this.host.db, c)} Lv.${c.level} (HP ${c.hp})`;
            b.onclick = () => {
              this.act({ kind: "switch", index: i });
              this.host.panels.closeAll();
            };
            return b;
          }),
        );
      },
      () => {
        if (this.view?.awaiting === "switch" && !this.awaitingServer) setTimeout(() => this.forceSwitch(), 50);
      },
    );
  }

  private act(action: BattleAction): void {
    const v = this.view;
    if (!v || this.awaitingServer) return;
    this.awaitingServer = true;
    this.host.ui.hideMenu();
    this.host.ui.say("…");
    this.host.send(v.id, action);
    // Server rejects (e.g. no PP) arrive as toasts; re-open the menu after a beat
    setTimeout(() => {
      if (this.awaitingServer && this.view === v && !this.aiming) {
        this.awaitingServer = false;
        this.showMenu();
      }
    }, 4000);
  }

  private viewOf(side: "player" | "foe"): PokemonView | null {
    return side === "player" ? this.mine : this.foe;
  }

  private posOf(side: "player" | "foe"): Vector3 {
    const v = this.viewOf(side);
    return (side === "player" ? this.minePos : this.foePos).add(new Vector3(0, Math.max(0.5, (v?.height ?? 1) * 0.55), 0));
  }

  private async doResult(msg: ServerMessageOf<"BATTLE_RESULT">): Promise<void> {
    if (!this.view || msg.battle.id !== this.view.id) return;
    this.awaitingServer = false;
    const { ui } = this.host;

    for (const ev of msg.events) await this.play(ev, msg.battle);

    this.view = msg.battle;
    if (msg.outcome) {
      await this.finish(msg.outcome);
      return;
    }
    ui.setFoe(msg.battle.foe, msg.battle.kind === "wild" || msg.battle.kind === "legendary");
    this.refreshMine();
    this.showMenu();
  }

  private async play(ev: BattleEvent, next: BattleView): Promise<void> {
    const { ui, effects, db } = this.host;
    switch (ev.t) {
      case "text":
        ui.say(ev.text);
        await ui.waitTap(950);
        break;
      case "move": {
        const attacker = this.viewOf(ev.side);
        const target = ev.side === "player" ? "foe" : "player";
        const color = db.typeColor(ev.type);
        attacker?.playAttack(ev.fx === "projectile");
        if (ev.fx === "projectile") await effects.projectile(this.posOf(ev.side), this.posOf(target), color);
        else if (ev.fx === "aura") await effects.aura(this.posOf(ev.side).add(new Vector3(0, -0.5, 0)), color);
        else {
          await wait(220);
          effects.sparks(this.posOf(target), color, 18);
        }
        break;
      }
      case "damage": {
        this.viewOf(ev.side)?.playHit();
        ui.setHp(ev.side, ev.hp, ev.maxHp);
        this.popNumber(ev.side, ev.amount, ev.eff > 1);
        this.host.sfx(ev.eff > 1 ? "super" : "hit");
        if (ev.crit || ev.eff > 1) this.flash();
        await wait(450);
        break;
      }
      case "heal":
        ui.setHp(ev.side, ev.hp, ev.maxHp);
        effects.sparks(this.posOf(ev.side), "#5fd38a", 20);
        await wait(350);
        break;
      case "status":
        ui.setStatus(ev.side, ev.status);
        if (ev.status) await effects.aura(this.posOf(ev.side).add(new Vector3(0, -0.5, 0)), statusColor(ev.status));
        break;
      case "miss":
        await wait(200);
        break;
      case "stat":
        await effects.aura(this.posOf(ev.side).add(new Vector3(0, -0.5, 0)), ev.stages > 0 ? "#ff9a3c" : "#6ab7ff");
        break;
      case "faint":
        this.viewOf(ev.side)?.playFaint();
        this.host.sfx("faint");
        await wait(900);
        break;
      case "switch":
        if (ev.side === "player") {
          const c = next.party.find((p) => p.uid === ev.creature.uid);
          if (c) {
            this.spawnMine(c);
            this.faceEachOther();
            this.view = { ...next, activeIndex: next.party.indexOf(c) };
            this.refreshMine();
            ui.say(`가랏, ${ev.creature.name}!`);
            effects.sparks(this.minePos.add(new Vector3(0, 0.6, 0)), "#ffffff", 18);
            await ui.waitTap(800);
          }
        } else {
          if (this.ownsFoeView && this.foe) this.host.lib.release(this.foe);
          this.foe = this.host.lib.acquire(ev.creature.species, { size: ev.creature.size, alpha: ev.creature.alpha });
          this.ownsFoeView = true;
          this.foe.root.position.copyFrom(this.foePos);
          this.foe.anim = "battle";
          this.faceEachOther();
          ui.setFoe(ev.creature, false);
          await wait(500);
        }
        break;
      case "capture":
        break;
      case "exp":
        ui.say(`${ev.name}은(는) 경험치 ${ev.amount}을(를) 얻었다!`);
        await ui.waitTap(900);
        break;
      case "level":
        this.host.sfx("level");
        ui.say(`${ev.name}의 레벨이 ${ev.level}(으)로 올랐다!`);
        effects.sparks(this.posOf("player"), "#ffde59", 30);
        await ui.waitTap(1100);
        break;
      case "learn":
        ui.say(ev.replaced ? `${ev.name}은(는) ${ev.replaced} 대신 ${ev.move}을(를) 배웠다!` : `${ev.name}은(는) ${ev.move}을(를) 배웠다!`);
        await ui.waitTap(1100);
        break;
      case "evolve":
        ui.say(`어라…? ${ev.from}의 모습이…!`);
        this.flash();
        await ui.waitTap(1200);
        ui.say(`${ev.from}은(는) ${ev.to}(으)로 진화했다!`);
        this.host.sfx("level");
        await ui.waitTap(1500);
        break;
      case "money":
        ui.say(`${ev.amount}원을 손에 넣었다!`);
        await ui.waitTap(900);
        break;
    }
  }

  private async finish(outcome: string): Promise<void> {
    const { ui } = this.host;
    ui.hideMenu();
    if (outcome === "win") {
      ui.say("배틀에서 이겼다!");
      await ui.waitTap(900);
    } else if (outcome === "lose") {
      await ui.waitTap(600);
    }
    this.cleanup();
    this.host.onEnd(outcome);
  }

  /** Ends presentation immediately (disconnect, teleport). */
  cleanup(): void {
    const v = this.view;
    this.view = null;
    this.awaitingServer = false;
    this.aiming = false;
    this.host.ui.setAiming(false);
    if (this.mine) this.host.lib.release(this.mine);
    this.mine = null;
    if (this.foe) {
      if (this.ownsFoeView) this.host.lib.release(this.foe);
      else this.foe.setVisible(true);
    }
    if (v?.entityId) {
      const e = this.host.creatures.get(v.entityId);
      if (e) e.pinned = false;
    }
    this.foe = null;
    this.ownsFoeView = false;
    this.host.camera.setBattle(null);
    this.host.ui.show(false);
    this.host.panels.closeAll();
    this.host.setFollowerHidden(false);
  }

  update(dt: number): void {
    if (!this.view) return;
    if (this.mine) {
      this.mine.root.position.copyFrom(this.minePos);
      this.mine.update(dt);
    }
    if (this.foe && this.ownsFoeView) this.foe.update(dt);
  }

  private popNumber(side: "player" | "foe", amount: number, big: boolean): void {
    const el = document.createElement("div");
    el.className = `damage-pop${big ? " super" : ""}`;
    el.textContent = `-${amount}`;
    el.style.left = side === "player" ? "62%" : "38%";
    el.style.top = "42%";
    document.getElementById("ui")!.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  private flash(): void {
    const el = document.createElement("div");
    el.className = "flash";
    document.getElementById("ui")!.appendChild(el);
    setTimeout(() => el.remove(), 520);
  }
}

export function statusColor(s: string): string {
  return ({ sleep: "#8a8aa8", freeze: "#8ad8f0", paralysis: "#f2d040", poison: "#a040a0", burn: "#f07030" } as Record<string, string>)[s] ?? "#ffffff";
}
