import type { CreatureInstance } from "./game";

export type BattleKind = "wild" | "trainer" | "guardian" | "legendary";

export type BattleAction =
  | { kind: "move"; index: number }
  | { kind: "switch"; index: number }
  | { kind: "item"; item: string; target: number }
  | { kind: "capture"; item: string }
  | { kind: "run" };

export type Side = "player" | "foe";

export interface BattleCreatureView {
  uid: string;
  species: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
}

export type BattleEvent =
  | { t: "text"; text: string }
  | { t: "move"; side: Side; move: string; moveName: string; type: string; fx: string }
  | { t: "damage"; side: Side; amount: number; hp: number; maxHp: number; eff: number; crit: boolean }
  | { t: "heal"; side: Side; amount: number; hp: number; maxHp: number }
  | { t: "miss"; side: Side }
  | { t: "stat"; side: Side; stat: string; stages: number }
  | { t: "faint"; side: Side }
  | { t: "switch"; side: Side; creature: BattleCreatureView }
  | { t: "capture"; item: string; shakes: number; success: boolean }
  | { t: "exp"; uid: string; name: string; amount: number }
  | { t: "level"; uid: string; name: string; level: number }
  | { t: "learn"; uid: string; name: string; move: string; replaced?: string }
  | { t: "evolve"; uid: string; from: string; to: string }
  | { t: "money"; amount: number };

export type BattleOutcome = "win" | "lose" | "run" | "capture";

export interface BattleView {
  id: string;
  kind: BattleKind;
  turn: number;
  canCapture: boolean;
  canRun: boolean;
  /** Player's active creature index in the party. */
  activeIndex: number;
  foe: BattleCreatureView;
  /** Foe trainer name, if any. */
  trainer?: string;
  foeRemaining: number;
  /** Wild/boss entity id in the world, if any. */
  entityId?: string;
  /** What the server is waiting for. */
  awaiting: "action" | "switch" | "none";
  party: CreatureInstance[];
}
