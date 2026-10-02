import type { PlayerStore } from "@server/persistence/PlayerStore";
import type { PlayerSave, WorldSave } from "@shared/types/save";

const DB_NAME = "pokeworld";
const DB_VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("players")) db.createObjectStore("players", { keyPath: "id" });
      if (!db.objectStoreNames.contains("world")) db.createObjectStore("world");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Browser-side save storage for single player (the local Simulation persists through this). */
export class IndexedDbStore implements PlayerStore {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    return (this.dbp ??= open());
  }

  async loadPlayer(id: string): Promise<PlayerSave | null> {
    const db = await this.db();
    return ((await tx(db, "players", "readonly", (s) => s.get(id))) as PlayerSave | undefined) ?? null;
  }

  async savePlayer(save: PlayerSave): Promise<void> {
    const db = await this.db();
    await tx(db, "players", "readwrite", (s) => s.put(structuredClone(save)));
  }

  async deletePlayer(id: string): Promise<void> {
    const db = await this.db();
    await tx(db, "players", "readwrite", (s) => s.delete(id));
    await tx(db, "world", "readwrite", (s) => s.delete("world"));
  }

  async setToken(): Promise<void> {}

  async checkToken(): Promise<boolean> {
    return true;
  }

  async loadWorld(): Promise<WorldSave | null> {
    const db = await this.db();
    return ((await tx(db, "world", "readonly", (s) => s.get("world"))) as WorldSave | undefined) ?? null;
  }

  async saveWorld(world: WorldSave): Promise<void> {
    const db = await this.db();
    await tx(db, "world", "readwrite", (s) => s.put(structuredClone(world), "world"));
  }

  /** Lightweight summary for the title screen. */
  async summary(id = "local"): Promise<{ name: string; partySize: number; playTime: number; updatedAt: number } | null> {
    try {
      const s = await this.loadPlayer(id);
      return s ? { name: s.name, partySize: s.party.length, playTime: s.playTime, updatedAt: s.updatedAt } : null;
    } catch {
      return null;
    }
  }
}
