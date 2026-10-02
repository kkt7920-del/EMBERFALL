import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { ContentDB } from "@shared/data/contentDb";
import { computeStats, creatureName, expForLevel } from "@shared/data/stats";
import type { ServerMessageOf } from "@shared/protocol/messages";
import type { BattleAction, BattleCreatureView, BattleEvent, BattleView } from "@shared/types/battle";
import type { CreatureInstance, PlayerPrivateState } from "@shared/types/game";
import type { CameraRig } from "../engine/CameraRig";
import type { Effects } from "../engine/Effects";
import type { CreatureLibrary, CreatureView } from "../pokemon/CreatureLibrary";
import type { CreatureManager } from "../pokemon/CreatureManager";
import type { BattleUI } from "../ui/BattleUI";
import type { Panels } from "../ui/panels";
import type { ClientTerrain } from "../world/ClientTerrain";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface BattleHost {
  db: ContentDB;
  ui: BattleUI;
  panels: Panels;
  camera: CameraRig;
  effects: Effects;
  lib: CreatureLibrary;
  creatures: CreatureManager;
  terrain: ClientTerrain;
  zone(): string;
  playerPos(): Vector3;
  playerRot(): number;
  state(): PlayerPrivateState | null;
  preferredOrb(): string;
  send(battleId: string, action: BattleAction): void;
  onStart(): void;
  onEnd(outcome: string | undefined): void;
  setFollowerHidden(on: boolean): void;
  sfx(name: "hit" | "super" | "faint" | "capture" | "level"): void;
}

/**
 * Presents a server-run battle in the open world: the partner steps out next
 * to the trainer, the camera frames both creatures, and server events are
 * played back in order (attack, damage, faint, capture shakes, exp, level up,
 * evolution). The client never computes outcomes.
 */
export class BattleController {
  view: BattleView | null = null;
  private mine: CreatureView | null = null;
  private foe: CreatureView | null = null;
  private ownsFoeView = false;
  private queue: Promise<void> = Promise.resolve();
  private awaitingServer = false;
  private minePos = new Vector3();
  private foePos = new Vector3();

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

  private groundAt(x: number, z: number): number {
    const zone = this.host.zone();
    const level = this.host.terrain.waterLevel(zone);
    return Math.max(this.host.terrain.ground(zone, x, z, 0.3), level !== null ? level - 0.45 : -Infinity);
  }

  private async doStart(view: BattleView): Promise<void> {
    const { db, ui } = this.host;
    this.view = view;
    this.host.onStart();
    this.host.setFollowerHidden(true);

    const player = this.host.playerPos();
    const entity = view.entityId ? this.host.creatures.get(view.entityId) : undefined;

    // Foe position: the wild creature where it stands, otherwise in front of the trainer
    if (entity) {
      entity.pinned = true;
      this.foe = entity.view;
      this.ownsFoeView = false;
      this.foePos.copyFrom(entity.view.root.position);
    } else {
      const r = this.host.playerRot();
      const fx = player.x + Math.sin(r) * 6;
      const fz = player.z + Math.cos(r) * 6;
      this.foe = this.host.lib.acquire(view.foe.species);
      this.ownsFoeView = true;
      this.foePos.set(fx, this.groundAt(fx, fz), fz);
      this.foe.root.position.copyFrom(this.foePos);
    }

    const toFoe = this.foePos.subtract(player);
    toFoe.y = 0;
    const dist = Math.max(3, toFoe.length());
    toFoe.normalize();
    const side = new Vector3(toFoe.z, 0, -toFoe.x);
    const mx = player.x + toFoe.x * Math.min(2.4, dist * 0.4) + side.x * 1.1;
    const mz = player.z + toFoe.z * Math.min(2.4, dist * 0.4) + side.z * 1.1;
    this.minePos.set(mx, this.groundAt(mx, mz), mz);
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
            ? `전설의 ${view.foe.name}이(가) 모습을 드러냈다!`
            : `야생 ${view.foe.name}이(가) 나타났다!`;
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
    this.mine = this.host.lib.acquire(c.species);
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
    const species = this.host.db.speciesOf(c);
    const max = computeStats(species, c.level, c.ivs).hp;
    const from = expForLevel(c.level);
    const to = expForLevel(c.level + 1);
    const plate: BattleCreatureView = { uid: c.uid, species: c.species, name: creatureName(this.host.db, c), level: c.level, hp: c.hp, maxHp: max };
    this.host.ui.setMine(plate, (c.exp - from) / Math.max(1, to - from));
  }

  private orbCount(): number {
    const st = this.host.state();
    if (!st) return 0;
    return Object.entries(st.inventory).reduce((n, [id, k]) => n + (this.host.db.items.get(id)?.kind === "capture" ? k : 0), 0);
  }

  private showMenu(): void {
    const v = this.view;
    if (!v) return;
    const { ui, panels, db } = this.host;
    if (v.awaiting === "switch") {
      ui.say("다음으로 내보낼 크리처를 고르자!");
      ui.hideMenu();
      this.forceSwitch();
      return;
    }
    const me = v.party[v.activeIndex];
    ui.say(`${creatureName(db, me)}은(는) 무엇을 할까?`);
    ui.rootMenu(
      {
        fight: (i) => this.act({ kind: "move", index: i }),
        capture: () => {
          const st = this.host.state();
          const pref = this.host.preferredOrb();
          const orb = st && (st.inventory[pref] ?? 0) > 0 ? pref : Object.keys(st?.inventory ?? {}).find((id) => db.items.get(id)?.kind === "capture" && (st!.inventory[id] ?? 0) > 0);
          if (orb) this.act({ kind: "capture", item: orb });
        },
        bag: () =>
          panels.bag({
            inBattle: true,
            onHeal: (item) => panels.party({ title: "누구에게 쓸까?", pickLabel: "사용", pick: (i) => this.act({ kind: "item", item, target: i }) }),
            onCapture: v.canCapture ? (item) => this.act({ kind: "capture", item }) : undefined,
          }),
        party: () =>
          panels.party({
            title: "교체할 크리처",
            pickLabel: "교체",
            canPick: (c, i) => c.hp > 0 && i !== v.activeIndex,
            pick: (i) => this.act({ kind: "switch", index: i }),
          }),
        run: () => this.act({ kind: "run" }),
      },
      { canCapture: v.canCapture, canRun: v.canRun, moves: me.moves, orbs: this.orbCount() },
    );
  }

  private forceSwitch(): void {
    const v = this.view;
    if (!v) return;
    this.host.panels.custom("다음 크리처를 고르세요", (body) => {
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
            // act() first so closing the panel doesn't re-open the forced choice
            this.act({ kind: "switch", index: i });
            this.host.panels.closeAll();
          };
          return b;
        }),
      );
    }, () => {
      // Cannot dismiss a forced switch
      if (this.view?.awaiting === "switch" && !this.awaitingServer) setTimeout(() => this.forceSwitch(), 50);
    });
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
      if (this.awaitingServer && this.view === v) {
        this.awaitingServer = false;
        this.showMenu();
      }
    }, 4000);
  }

  private viewOf(side: "player" | "foe"): CreatureView | null {
    return side === "player" ? this.mine : this.foe;
  }

  private posOf(side: "player" | "foe"): Vector3 {
    return (side === "player" ? this.minePos : this.foePos).add(new Vector3(0, 0.7, 0));
  }

  private async doResult(msg: ServerMessageOf<"BATTLE_RESULT">): Promise<void> {
    if (!this.view || msg.battle.id !== this.view.id) return;
    this.awaitingServer = false;
    const { ui, db, effects } = this.host;

    for (const ev of msg.events) await this.play(ev, msg.battle);

    this.view = msg.battle;
    if (msg.outcome) {
      await this.finish(msg.outcome);
      return;
    }
    ui.setFoe(msg.battle.foe, msg.battle.kind === "wild" || msg.battle.kind === "legendary");
    this.refreshMine();
    void db;
    void effects;
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
        attacker?.playAttack();
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
      case "miss":
        await wait(200);
        break;
      case "stat":
        await effects.aura(this.posOf(ev.side).add(new Vector3(0, -0.5, 0)), ev.stages > 0 ? "#ff9a3c" : "#6ab7ff");
        break;
      case "faint":
        this.viewOf(ev.side)?.playFaint();
        this.host.sfx("faint");
        await wait(800);
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
          this.foe = this.host.lib.acquire(ev.creature.species);
          this.ownsFoeView = true;
          this.foe.root.position.copyFrom(this.foePos);
          this.foe.anim = "battle";
          this.faceEachOther();
          ui.setFoe(ev.creature, false);
          await wait(500);
        }
        break;
      case "capture": {
        const item = db.items.get(ev.item);
        const from = this.minePos.add(new Vector3(0, 1.4, 0));
        const to = this.posOf("foe");
        await effects.throwOrb(from, to, item?.color ?? "#e04848");
        this.foe?.setVisible(false);
        await effects.shakeOrb(new Vector3(this.foePos.x, this.foePos.y + 0.16, this.foePos.z), ev.shakes);
        effects.hideOrb(ev.success);
        if (ev.success) {
          this.host.sfx("capture");
          ui.say("잡았다!");
        } else {
          this.foe?.setVisible(true);
          ui.say(ev.shakes === 0 ? "앗, 바로 튀어나왔다!" : "아깝다! 조금만 더 하면 잡을 수 있었는데!");
        }
        await ui.waitTap(1000);
        break;
      }
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

  /** Ends presentation immediately (disconnect, zone change). */
  cleanup(): void {
    const v = this.view;
    this.view = null;
    this.awaitingServer = false;
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
      this.mine.update(dt, this.minePos.y);
    }
    if (this.foe && this.ownsFoeView) this.foe.update(dt, this.foePos.y);
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
