import { ContentDB, type ContentFiles } from "@shared/data/contentDb";

/**
 * The content pack is bundled from /content at build time. Replace the JSON
 * files (species, models, spawns, regions, ...) to ship a different pack.
 */
const files = import.meta.glob("../../content/**/*.json", { eager: true, import: "default" }) as ContentFiles;

let cached: ContentDB | null = null;

export function loadContent(): ContentDB {
  if (!cached) {
    const normalized: ContentFiles = {};
    for (const [path, json] of Object.entries(files)) normalized[path.replace(/^(\.\.\/)+/, "")] = json;
    cached = ContentDB.fromFiles(normalized);
  }
  return cached;
}

/** Raw region JSON for the terrain worker (it rebuilds its own WorldTerrain). */
export function regionForWorker(db: ContentDB) {
  return db.defaultRegion();
}
