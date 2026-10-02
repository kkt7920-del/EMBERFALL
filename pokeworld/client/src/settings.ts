import { type QualityPresetId, type QualitySettings, presetSettings } from "@shared/config/quality";
import { Device } from "./mobile/Device";

const KEY = "pokeworld.settings.v2";

export interface ClientSettings extends QualitySettings {
  renderer: "webgl2" | "webgpu";
  /** Show on-screen touch controls even with a mouse. */
  touchControls: "auto" | "on" | "off";
  cameraSensitivity: number;
  invertY: boolean;
  sound: boolean;
  /** Phone / gamepad vibration on captures. */
  vibration: boolean;
}

export function defaultPreset(): QualityPresetId {
  if (Device.mobile) return "low";
  return (navigator.hardwareConcurrency ?? 8) <= 4 ? "medium" : "high";
}

export function defaultSettings(): ClientSettings {
  return {
    ...presetSettings(defaultPreset()),
    renderer: "webgl2",
    touchControls: "auto",
    cameraSensitivity: 1,
    invertY: false,
    sound: true,
    vibration: true,
  };
}

export function loadSettings(): ClientSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    // private mode / blocked storage
  }
  return defaultSettings();
}

export function saveSettings(s: ClientSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function applyPreset(s: ClientSettings, id: QualityPresetId): ClientSettings {
  return { ...s, ...presetSettings(id), showFps: s.showFps };
}

export function useTouchControls(s: ClientSettings): boolean {
  return s.touchControls === "on" || (s.touchControls === "auto" && Device.touch);
}
