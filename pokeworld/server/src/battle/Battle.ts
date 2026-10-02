import type { ContentDB } from "@shared/data/contentDb";
import { computeStats, creatureName, maxHp } from "@shared/data/stats";
import type { Rng } from "@shared/math/rng";
import type { MoveDef, TrainerDef } from "@shared/types/content";
import type { BattleAction, BattleCreatureView, BattleEvent, BattleKind, BattleOutcome, BattleView, Side } from "@shared/types/battle";
import type { CreatureInstance } from "@shared/types/game";
import { expReward, grantExp } from "../pokemon/progression";
import { rollCapture } from "./capture";
import { computeDamage, effectiveStat, freshStages, type Stages } from "./damage";

export interface BattleSetup {
  id: string;
  kind: BattleKind;
  playerId: string;
  /** Live reference to the player's party; HP/PP/exp changes persist. */
  party: CreatureInstance[];
  foes: CreatureInstance[];
  trainer?: TrainerDef;
  entityId?: string;
  canCapture: boolean;
  canRun: boolean;
  /** Extra capture multiplier (story encounters are easier to catch). */
  captureBonus?: number;
}

export interface Inventory {
  count(item: string): number;
  consume(item: string): boolean;
}

export interface TurnResult {
  events: BattleEvent[];
  outcome?: BattleOutcome;
  captured?: CreatureInstance;
}

/** Fallback when every move is out of PP. */
const STRUGGLE: MoveDef = { id: "struggle", name: "발버둥", type: "normal", category: "physical", power: 40, accuracy: 100, pp: 1, fx: "melee" };

/**
 * One 1v1 turn-based battle. Pure game logic: no I/O, deterministic for a
 * given RNG, so the same code runs in the browser's local server and on Node.
 */
export class Battle {
  turn = 1;
  activeIndex: number;
  foeIndex = 0;
  awaiting: "action" | "switch" | "none" = "action";
  outcome: BattleOutcome | null = null;
  private playerStages: Stages = freshStages();
  private foeStages: Stages = freshStages();
  private runAttempts = 0;

  constructor(
    private readonly db: ContentDB,
    private readonly rng: Rng,
    readonly setup: BattleSetup,
  ) {
    const first = setup.party.findIndex((c) => c.hp > 0);
    if (first < 0) throw new Error("battle needs a healthy creature");
    if (setup.foes.length === 0) throw new Error("battle needs a foe");
    this.activeIndex = first;
  }

  get id(): string {
    return this.setup.id;
  }

  get active(): CreatureInstance {
    return this.setup.party[this.activeIndex];
  }

  get foe(): CreatureInstance {
    return this.setup.foes[this.foeIndex];
  }

  get ended(): boolean {
    return this.outcome !== null;
  }

  view(): BattleView {
    const s = this.setup;
    return {
      id: s.id,
      kind: s.kind,
      turn: this.turn,
      canCapture: s.canCapture,
      canRun: s.canRun,
      activeIndex: this.activeIndex,
      foe: this.creatureView(this.foe),
      trainer: s.trainer ? `${s.trainer.title} ${s.trainer.name}` : undefined,
      foeRemaining: s.foes.filter((f) => f.hp > 0).length,
      entityId: s.entityId,
      awaiting: this.ended ? "none" : this.awaiting,
      party: s.party,
    };
  }

  act(action: BattleAction, inventory: Inventory): TurnResult | { error: string } {
    if (this.ended) return { error: "battle is over" };
    const events: BattleEvent[] = [];
    const party = this.setup.party;

    if (this.awaiting === "switch") {
      if (action.kind !== "switch") return { error: "choose a creature to send out" };
      const err = this.validateSwitch(action.index);
      if (err) return { error: err };
      this.switchTo(action.index, events);
      this.awaiting = "action";
      return { events };
    }

    switch (action.kind) {
      case "move": {
        const slot = this.active.moves[action.index];
        if (!slot) return { error: "no such move" };
        const anyPp = this.active.moves.some((m) => m.pp > 0);
        if (slot.pp <= 0 && anyPp) return { error: "no PP left" };
        const playerMove = anyPp ? this.db.moves.get(slot.id)! : STRUGGLE;
        if (anyPp) slot.pp--;
        const foeMove = this.pickFoeMove();
        this.resolveTurn(playerMove, foeMove, events);
        break;
      }
      case "switch": {
        const err = this.validateSwitch(action.index);
        if (err) return { error: err };
        this.switchTo(action.index, events);
        this.foeOnlyTurn(events);
        break;
      }
      case "item": {
        const item = this.db.items.get(action.item);
        const target = party[action.target];
        if (!item || item.kind !== "heal") return { error: "not a healing item" };
        if (!target || target.hp <= 0) return { error: "invalid target" };
        const max = maxHp(this.db, target);
        if (target.hp >= max) return { error: "already at full HP" };
        if (!inventory.consume(item.id)) return { error: "you have none left" };
        const amount = Math.min(item.heal ?? 0, max - target.hp);
        target.hp += amount;
        if (action.target === this.activeIndex) events.push({ t: "heal", side: "player", amount, hp: target.hp, maxHp: max });
        events.push({ t: "text", text: `${creatureName(this.db, target)}의 HP가 ${amount} 회복되었다!` });
        this.foeOnlyTurn(events);
        break;
      }
      case "capture": {
        const item = this.db.items.get(action.item);
        if (!this.setup.canCapture) return { error: "can't capture here" };
        if (!item || item.kind !== "capture") return { error: "not a capture item" };
        if (!inventory.consume(item.id)) return { error: "you have none left" };
        const roll = rollCapture(this.db, this.foe, (item.captureBonus ?? 1) * (this.setup.captureBonus ?? 1), this.rng);
        events.push({ t: "capture", item: item.id, shakes: roll.shakes, success: roll.success });
        if (roll.success) {
          this.outcome = "capture";
          return { events, outcome: "capture", captured: this.foe };
        }
        this.foeOnlyTurn(events);
        break;
      }
      case "run": {
        if (!this.setup.canRun) return { error: "can't run from this battle" };
        this.runAttempts++;
        const mine = effectiveStat(this.db, this.active, "spe", this.playerStages);
        const theirs = effectiveStat(this.db, this.foe, "spe", this.foeStages);
        if (mine >= theirs || this.rng.next() < 0.5 + 0.15 * this.runAttempts) {
          events.push({ t: "text", text: "무사히 도망쳤다!" });
          this.outcome = "run";
          return { events, outcome: "run" };
        }
        events.push({ t: "text", text: "도망칠 수 없었다!" });
        this.foeOnlyTurn(events);
        break;
      }
      default:
        return { error: "unknown action" };
    }

    this.turn++;
    return { events, outcome: this.outcome ?? undefined };
  }

  private validateSwitch(index: number): string | null {
    const c = this.setup.party[index];
    if (!c) return "no such creature";
    if (c.hp <= 0) return "that creature has fainted";
    if (index === this.activeIndex) return "already in battle";
    return null;
  }

  private switchTo(index: number, events: BattleEvent[]): void {
    this.activeIndex = index;
    this.playerStages = freshStages();
    events.push({ t: "switch", side: "player", creature: this.creatureView(this.active) });
  }

  private resolveTurn(playerMove: MoveDef, foeMove: MoveDef, events: BattleEvent[]): void {
    const pPri = playerMove.priority ?? 0;
    const fPri = foeMove.priority ?? 0;
    const pSpe = effectiveStat(this.db, this.active, "spe", this.playerStages);
    const fSpe = effectiveStat(this.db, this.foe, "spe", this.foeStages);
    const playerFirst = pPri !== fPri ? pPri > fPri : pSpe !== fSpe ? pSpe > fSpe : this.rng.next() < 0.5;

    const order: [Side, MoveDef][] = playerFirst
      ? [
          ["player", playerMove],
          ["foe", foeMove],
        ]
      : [
          ["foe", foeMove],
          ["player", playerMove],
        ];

    for (const [side, move] of order) {
      if (this.ended || this.awaiting === "switch") return;
      const user = side === "player" ? this.active : this.foe;
      if (user.hp <= 0) continue;
      // A foe that just replaced a fainted one does not act this turn
      if (side === "foe" && this.foeReplacedThisTurn) continue;
      this.useMove(side, move, events);
    }
    this.foeReplacedThisTurn = false;
  }

  private foeReplacedThisTurn = false;

  private foeOnlyTurn(events: BattleEvent[]): void {
    if (this.ended) return;
    this.useMove("foe", this.pickFoeMove(), events);
    this.foeReplacedThisTurn = false;
  }

  private useMove(side: Side, move: MoveDef, events: BattleEvent[]): void {
    const attacker = side === "player" ? this.active : this.foe;
    const defender = side === "player" ? this.foe : this.active;
    const aStages = side === "player" ? this.playerStages : this.foeStages;
    const dStages = side === "player" ? this.foeStages : this.playerStages;
    const other: Side = side === "player" ? "foe" : "player";

    events.push({ t: "move", side, move: move.id, moveName: move.name, type: move.type, fx: move.fx ?? "melee" });
    events.push({ t: "text", text: `${creatureName(this.db, attacker)}의 ${move.name}!` });

    const selfTargeted = move.category === "status" && (move.effect?.kind === "heal" || (move.effect?.kind === "stat" && move.effect.target === "self"));
    if (!selfTargeted && this.rng.next() * 100 >= move.accuracy) {
      events.push({ t: "miss", side: other });
      events.push({ t: "text", text: "공격이 빗나갔다!" });
      return;
    }

    if (move.category !== "status") {
      const result = computeDamage(this.db, attacker, aStages, defender, dStages, move, this.rng);
      const dealt = Math.min(defender.hp, result.damage);
      defender.hp -= dealt;
      events.push({
        t: "damage",
        side: other,
        amount: dealt,
        hp: defender.hp,
        maxHp: maxHp(this.db, defender),
        eff: result.eff,
        crit: result.crit,
      });
      if (result.crit) events.push({ t: "text", text: "급소에 맞았다!" });
      if (result.eff === 0) events.push({ t: "text", text: "효과가 없는 것 같다…" });
      else if (result.eff > 1) events.push({ t: "text", text: "효과가 굉장했다!" });
      else if (result.eff < 1) events.push({ t: "text", text: "효과가 별로인 듯하다…" });

      if (move.effect?.kind === "drain" && dealt > 0) {
        const max = maxHp(this.db, attacker);
        const heal = Math.min(max - attacker.hp, Math.max(1, Math.floor(dealt * move.effect.fraction)));
        if (heal > 0) {
          attacker.hp += heal;
          events.push({ t: "heal", side, amount: heal, hp: attacker.hp, maxHp: max });
        }
      }
    }

    const effect = move.effect;
    if (effect?.kind === "stat" && defender.hp > 0 && (effect.chance === undefined || this.rng.next() < effect.chance)) {
      const targetSide: Side = effect.target === "self" ? side : other;
      const stages = targetSide === "player" ? this.playerStages : this.foeStages;
      const before = stages[effect.stat];
      stages[effect.stat] = Math.max(-6, Math.min(6, before + effect.stages));
      const changed = stages[effect.stat] - before;
      const who = creatureName(this.db, targetSide === "player" ? this.active : this.foe);
      if (changed === 0) events.push({ t: "text", text: `${who}의 능력은 더 이상 변하지 않는다!` });
      else {
        events.push({ t: "stat", side: targetSide, stat: effect.stat, stages: changed });
        events.push({ t: "text", text: `${who}의 ${STAT_NAMES[effect.stat]}이(가) ${changed > 0 ? "올라갔다" : "떨어졌다"}!` });
      }
    } else if (effect?.kind === "heal") {
      const max = maxHp(this.db, attacker);
      const heal = Math.min(max - attacker.hp, Math.floor(max * effect.fraction));
      attacker.hp += heal;
      events.push({ t: "heal", side, amount: heal, hp: attacker.hp, maxHp: max });
    }

    this.checkFaints(events);
  }

  private checkFaints(events: BattleEvent[]): void {
    if (this.foe.hp <= 0) {
      events.push({ t: "faint", side: "foe" });
      events.push({ t: "text", text: `${this.foeLabel()} ${creatureName(this.db, this.foe)}은(는) 쓰러졌다!` });
      if (this.active.hp > 0) {
        const boosted = this.setup.kind !== "wild";
        events.push(...grantExp(this.db, this.active, expReward(this.db, this.foe, boosted)));
      }
      const next = this.setup.foes.findIndex((f, i) => i > this.foeIndex && f.hp > 0);
      if (next >= 0) {
        this.foeIndex = next;
        this.foeStages = freshStages();
        this.foeReplacedThisTurn = true;
        events.push({ t: "switch", side: "foe", creature: this.creatureView(this.foe) });
        events.push({ t: "text", text: `${this.foeLabel()}은(는) ${creatureName(this.db, this.foe)}을(를) 내보냈다!` });
      } else {
        this.outcome = "win";
        if (this.setup.trainer) {
          events.push({ t: "money", amount: this.setup.trainer.reward });
          events.push({ t: "text", text: `${this.setup.trainer.title} ${this.setup.trainer.name}: "${this.setup.trainer.dialogue.win}"` });
        }
        return;
      }
    }

    if (this.active.hp <= 0) {
      events.push({ t: "faint", side: "player" });
      events.push({ t: "text", text: `${creatureName(this.db, this.active)}은(는) 쓰러졌다!` });
      if (this.setup.party.some((c) => c.hp > 0)) this.awaiting = "switch";
      else this.outcome = "lose";
    }
  }

  private foeLabel(): string {
    return this.setup.kind === "wild" ? "야생" : this.setup.kind === "trainer" ? "상대" : "";
  }

  private pickFoeMove(): MoveDef {
    const foe = this.foe;
    const usable = foe.moves.filter((m) => m.pp > 0);
    if (usable.length === 0) return STRUGGLE;

    let slot = this.rng.pick(usable);
    if (this.setup.kind !== "wild" && this.rng.next() < 0.7) {
      let best = -1;
      for (const m of usable) {
        const def = this.db.moves.get(m.id)!;
        const stab = this.db.speciesOf(foe).types.includes(def.type) ? 1.5 : 1;
        const score = def.power * stab * this.db.effectiveness(def.type, this.db.speciesOf(this.active).types);
        if (score > best) {
          best = score;
          slot = m;
        }
      }
    }
    slot.pp--;
    return this.db.moves.get(slot.id)!;
  }

  private creatureView(c: CreatureInstance): BattleCreatureView {
    return {
      uid: c.uid,
      species: c.species,
      name: creatureName(this.db, c),
      level: c.level,
      hp: c.hp,
      maxHp: computeStats(this.db.speciesOf(c), c.level, c.ivs).hp,
    };
  }
}

const STAT_NAMES: Record<string, string> = { atk: "공격", def: "방어", spa: "특수공격", spd: "특수방어", spe: "스피드" };
