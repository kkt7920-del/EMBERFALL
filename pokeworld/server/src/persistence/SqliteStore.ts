import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PlayerSave, WorldSave } from "@shared/types/save";
import type { PlayerStore } from "./PlayerStore";

const hashToken = (token: string) => createHash("sha256").update(token).digest();

/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addon to build).
 * Saves are versioned JSON documents; see shared/types/save.ts for migrations.
 * Swap for a PostgreSQL implementation of PlayerStore when scaling out.
 */
export class SqliteStore implements PlayerStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        token_hash BLOB,
        name TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        data TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS world (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
    `);
  }

  async loadPlayer(id: string): Promise<PlayerSave | null> {
    const row = this.db.prepare("SELECT data FROM players WHERE id = ?").get(id) as { data: string | null } | undefined;
    return row?.data ? (JSON.parse(row.data) as PlayerSave) : null;
  }

  async savePlayer(save: PlayerSave): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO players (id, name, version, data, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(save.id, save.name, save.version, JSON.stringify(save), save.updatedAt);
  }

  async setToken(id: string, token: string): Promise<void> {
    this.db
      .prepare("INSERT INTO players (id, token_hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash")
      .run(id, hashToken(token));
  }

  async checkToken(id: string, token: string): Promise<boolean> {
    const row = this.db.prepare("SELECT token_hash FROM players WHERE id = ?").get(id) as { token_hash: Uint8Array | null } | undefined;
    if (!row?.token_hash) return false;
    const a = Buffer.from(row.token_hash);
    const b = hashToken(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async loadWorld(): Promise<WorldSave | null> {
    const row = this.db.prepare("SELECT data FROM world WHERE id = 1").get() as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as WorldSave) : null;
  }

  async saveWorld(world: WorldSave): Promise<void> {
    this.db.prepare("INSERT INTO world (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(world));
  }

  close(): void {
    this.db.close();
  }
}
