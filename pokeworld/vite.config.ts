import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const SERVER_PORT = Number(process.env.POKEWORLD_PORT ?? 2567);

export default defineConfig({
  root: ".",
  // VITE_BASE=./ builds a relocatable client (static hosts, share links)
  base: process.env.VITE_BASE ?? "/",
  publicDir: "public",
  resolve: {
    alias: {
      "@shared": r("./shared"),
      "@server": r("./server/src"),
      "@client": r("./client/src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      "/api": { target: `http://localhost:${SERVER_PORT}` },
    },
  },
  preview: { host: true, port: 4173 },
  build: {
    outDir: process.env.VITE_OUT_DIR ?? "dist/client",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("@babylonjs") ? "babylon" : undefined),
      },
    },
  },
});
