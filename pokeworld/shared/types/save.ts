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
  /** Set by a migration when the stored position is no longer valid. */
  respawn?: boolean;
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
/** v1 used invented placeholder creatures; v2 uses Pokémon species. */
const V1_SPECIES: Record<string, string> = {
  ancientguard: "golurk",
  aurorawing: "ho_oh",
  blazehound: "growlithe",
  bouldron: "graveler",
  chirpling: "pidgey",
  coralfish: "horsea",
  crystalite: "carbink",
  deepjaw: "relicanth",
  dropnewt: "squirtle",
  emberpup: "charmander",
  foxfire: "vulpix",
  glowshroom: "paras",
  gullwing: "wingull",
  ironbeetle: "pinsir",
  leafbun: "bulbasaur",
  meadowbug: "caterpie",
  mossturtle: "ivysaur",
  mudpup: "wooper",
  nightowl: "hoothoot",
  pebblet: "geodude",
  reedfrog: "poliwag",
  riverotter: "psyduck",
  shadebat: "zubat",
  shellcrab: "krabby",
  silkmoth: "butterfree",
  skyhawk: "pidgeotto",
  sparkmouse: "pikachu",
  stagleaf: "tauros",
  thornhare: "sentret",
  tidenewt: "wartortle",
  voltail: "raichu",
};
const V1_ITEMS: Record<string, string> = { capture_orb: "poke_ball", great_orb: "great_ball" };

const MIGRATIONS: Record<number, Migration> = {
  0: (s) => ({
    ...s,
    flags: s.flags ?? { starterChosen: Array.isArray(s.party) && s.party.length > 0, trainersDefeated: [], collected: [], visited: [] },
    legendary: s.legendary ?? { nodes: {}, completed: [] },
    version: 1,
  }),
  1: (s) => {
    const mapCreature = (c: Record<string, unknown>) => ({ ...c, species: V1_SPECIES[c.species as string] ?? c.species, moves: [], needsRepair: true });
    const inv: Record<string, number> = {};
    for (const [id, n] of Object.entries((s.inventory as Record<string, number>) ?? {})) {
      const nid = V1_ITEMS[id] ?? id;
      inv[nid] = (inv[nid] ?? 0) + n;
    }
    const mapList = (l: unknown) => (Array.isArray(l) ? l.map((x) => V1_SPECIES[x as string] ?? x) : []);
    return {
      ...s,
      party: Array.isArray(s.party) ? s.party.map(mapCreature) : [],
      box: Array.isArray(s.box) ? s.box.map(mapCreature) : [],
      inventory: inv,
      seen: mapList(s.seen),
      caught: mapList(s.caught),
      // The world was regenerated as a 3D voxel world: start again in town
      zone: "overworld",
      respawn: true,
      version: 2,
    };
  },
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
