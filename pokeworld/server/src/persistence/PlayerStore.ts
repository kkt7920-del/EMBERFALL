import type { PlayerSave, WorldSave } from "@shared/types/save";

/** Storage backend for the simulation: SQLite on the Node server, IndexedDB in the browser. */
export interface PlayerStore {
  loadPlayer(id: string): Promise<PlayerSave | null>;
  savePlayer(save: PlayerSave): Promise<void>;
  /** Associates a secret with a player id (multiplayer re-join). */
  setToken(id: string, token: string): Promise<void>;
  checkToken(id: string, token: string): Promise<boolean>;
  loadWorld(): Promise<WorldSave | null>;
  saveWorld(world: WorldSave): Promise<void>;
}

/** In-memory store for tests and throwaway sessions. */
export class MemoryStore implements PlayerStore {
  readonly players = new Map<string, PlayerSave>();
  readonly tokens = new Map<string, string>();
  world: WorldSave | null = null;

  async loadPlayer(id: string) {
    const s = this.players.get(id);
    return s ? structuredClone(s) : null;
  }
  async savePlayer(save: PlayerSave) {
    this.players.set(save.id, structuredClone(save));
  }
  async setToken(id: string, token: string) {
    this.tokens.set(id, token);
  }
  async checkToken(id: string, token: string) {
    return this.tokens.get(id) === token;
  }
  async loadWorld() {
    return this.world ? structuredClone(this.world) : null;
  }
  async saveWorld(world: WorldSave) {
    this.world = structuredClone(world);
  }
}
