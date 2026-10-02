// Bundles the Node game server (server/src/main.ts + shared) into dist/server/main.js.
import { build } from "esbuild";

await build({
  entryPoints: ["server/src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server/main.js",
  sourcemap: true,
  packages: "external",
  tsconfig: "tsconfig.json",
  logLevel: "info",
});
