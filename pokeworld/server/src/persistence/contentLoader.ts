import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ContentDB, type ContentFiles } from "@shared/data/contentDb";

/** Reads every JSON file under `dir` (a content pack root) into a ContentDB. */
export function loadContentFromDisk(dir: string): ContentDB {
  const files: ContentFiles = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".json")) files[`content/${relative(dir, full).replace(/\\/g, "/")}`] = JSON.parse(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return ContentDB.fromFiles(files);
}
