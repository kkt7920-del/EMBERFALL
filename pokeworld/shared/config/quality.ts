export type ShadowQuality = "off" | "low" | "medium" | "high";

export type QualityPresetId = "low" | "medium" | "high";

export interface QualitySettings {
  preset: QualityPresetId | "custom";
  /** Fraction of native resolution actually rendered. */
  renderScale: number;
  /** Chunks loaded around the player: 1 => 3x3, 2 => 5x5, 3 => 7x7. */
  chunkRadius: 1 | 2 | 3;
  shadows: ShadowQuality;
  /** Ring (in chunks) within which grass/flowers are drawn. */
  vegetationRadius: 0 | 1 | 2;
  /** Max live particles across all effects. */
  particleBudget: number;
  /** Creatures further than this are not drawn. */
  creatureViewDistance: number;
  /** Cap for the frame rate; 0 = uncapped (vsync). */
  maxFps: 0 | 30 | 60;
  showFps: boolean;
}

export const QUALITY_PRESETS: Record<QualityPresetId, Omit<QualitySettings, "preset" | "showFps">> = {
  low: {
    renderScale: 0.75,
    chunkRadius: 1,
    shadows: "off",
    vegetationRadius: 0,
    particleBudget: 150,
    creatureViewDistance: 60,
    maxFps: 60,
  },
  medium: {
    renderScale: 0.9,
    chunkRadius: 2,
    shadows: "low",
    vegetationRadius: 1,
    particleBudget: 400,
    creatureViewDistance: 90,
    maxFps: 0,
  },
  high: {
    renderScale: 1,
    chunkRadius: 3,
    shadows: "medium",
    vegetationRadius: 2,
    particleBudget: 1200,
    creatureViewDistance: 130,
    maxFps: 0,
  },
};

export function presetSettings(id: QualityPresetId): QualitySettings {
  return { preset: id, showFps: false, ...QUALITY_PRESETS[id] };
}
