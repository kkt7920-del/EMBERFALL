/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for builds embedded in a viewer frame (no service worker, no install prompt). */
  readonly VITE_EMBEDDED?: string;
  readonly VITE_SERVER_URL?: string;
}
