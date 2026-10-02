import { SAVE_VERSION } from "../config/constants";
import type { CreatureInstance, LegendaryState, PlayerFlags, QuestState } from "./game";

/** Everything persisted for one player, locally (IndexedDB) or on the server (SQLite). */
export interface PlayerSave {
  version: number;
  id: string;
  name: string;
  zone: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  party: CreatureInstance[];
  box: CreatureInstance[];
  inventory: Record<string, number>;
  money: number;
  flags: PlayerFlags;
  quests: QuestState;
  legendary: LegendaryState;
  seen: string[];
  caught: string[];
  playTime: number;
  createdAt: number;
  updatedAt: number;
}

/** World-level state persisted alongside players (time of day, one-shot world events). */
export interface WorldSave {
  version: number;
  time: number;
  weather: string;
  /** Legendary events whose single reward has already been claimed in this world. */
  claimedLegendaries: string[];
}

type Migration = (save: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations from version N to N+1, keyed by N. Add an entry whenever
 * SAVE_VERSION is bumped. Version 0 saves are pre-release prototypes that
 * lacked flags/legendary state.
 */
const MIGRATIONS: Record<number, Migration> = {
  0: (s) => ({
    ...s,
    flags: s.flags ?? { starterChosen: Array.isArray(s.party) && s.party.length > 0, trainersDefeated: [], collected: [], visited: [] },
    legendary: s.legendary ?? { nodes: {}, completed: [] },
    version: 1,
  }),
};

export function migrateSave(raw: unknown): PlayerSave {
  if (typeof raw !== "object" || raw === null) throw new Error("save is not an object");
  let save = { ...(raw as Record<string, unknown>) };
  let version = typeof save.version === "number" ? save.version : 0;

  if (version > SAVE_VERSION) throw new Error(`save version ${version} is newer than supported ${SAVE_VERSION}`);

  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`no migration from save version ${version}`);
    save = step(save);
    version = save.version as number;
  }

  return validateSave(save);
}

function validateSave(s: Record<string, unknown>): PlayerSave {
  const need = (key: string, type: string) => {
    if (typeof s[key] !== type) throw new Error(`save.${key} must be ${type}`);
  };
  need("id", "string");
  need("name", "string");
  need("zone", "string");
  for (const k of ["x", "y", "z", "rotY", "money", "playTime"]) need(k, "number");
  if (!Array.isArray(s.party) || !Array.isArray(s.box)) throw new Error("save.party/box must be arrays");
  return s as unknown as PlayerSave;
}
