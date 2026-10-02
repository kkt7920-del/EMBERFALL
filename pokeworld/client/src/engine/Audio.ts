/**
 * Sound event registry. Every gameplay sound is a named event; each event
 * has a synthesized default (no audio assets needed) and can be replaced by
 * an audio file via `register(name, url)` (e.g. a pack's sounds). Unlocked on
 * the first user gesture, as browsers require.
 */
export type SoundEvent =
  | "hit"
  | "super"
  | "faint"
  | "level"
  | "ui"
  | "ball_equip"
  | "ball_select"
  | "ball_throw"
  | "ball_fly"
  | "ball_hit"
  | "ball_bounce"
  | "ball_open"
  | "capture_beam"
  | "ball_close"
  | "ball_shake"
  | "capture_success"
  | "capture_breakout"
  | "capture_critical"
  | "ball_pickup";

type Recipe = (s: Sfx) => void;

const RECIPES: Record<SoundEvent, Recipe> = {
  hit: (s) => s.tone(180, 0.12, "square", 0.06, -80),
  super: (s) => {
    s.tone(220, 0.1, "square", 0.07, -100);
    s.tone(330, 0.16, "sawtooth", 0.05, -150);
  },
  faint: (s) => s.tone(400, 0.6, "triangle", 0.07, -320),
  level: (s) => {
    s.tone(523, 0.1, "triangle", 0.07);
    s.later(100, () => s.tone(659, 0.1, "triangle", 0.07));
    s.later(200, () => s.tone(784, 0.22, "triangle", 0.07));
  },
  ui: (s) => s.tone(880, 0.05, "sine", 0.03),
  ball_equip: (s) => {
    s.tone(520, 0.05, "square", 0.03);
    s.later(45, () => s.tone(780, 0.06, "square", 0.03));
  },
  ball_select: (s) => s.tone(660, 0.04, "square", 0.025),
  ball_throw: (s) => s.noise(0.28, 0.06, 1400, 3200),
  ball_fly: (s) => s.noise(0.5, 0.025, 600, 1800),
  ball_hit: (s) => {
    s.tone(240, 0.08, "square", 0.08, -120);
    s.noise(0.08, 0.07, 2000, 900);
  },
  ball_bounce: (s) => s.tone(320, 0.06, "triangle", 0.05, -160),
  ball_open: (s) => {
    s.tone(900, 0.06, "square", 0.04, 400);
    s.noise(0.12, 0.04, 3000, 6000);
  },
  capture_beam: (s) => s.tone(300, 0.75, "sawtooth", 0.035, 900),
  ball_close: (s) => {
    s.tone(1200, 0.04, "square", 0.05);
    s.later(50, () => s.tone(600, 0.06, "square", 0.05));
  },
  ball_shake: (s) => {
    s.tone(180, 0.05, "square", 0.05);
    s.later(90, () => s.tone(160, 0.05, "square", 0.05));
    s.later(160, () => s.tone(420, 0.04, "sine", 0.03));
  },
  capture_success: (s) => {
    s.tone(660, 0.1, "square", 0.05);
    s.later(110, () => s.tone(880, 0.1, "square", 0.05));
    s.later(220, () => s.tone(990, 0.1, "square", 0.05));
    s.later(330, () => s.tone(1320, 0.35, "square", 0.05));
  },
  capture_breakout: (s) => {
    s.noise(0.3, 0.09, 4000, 500);
    s.tone(700, 0.25, "sawtooth", 0.05, -500);
  },
  capture_critical: (s) => {
    s.tone(1500, 0.08, "sine", 0.06);
    s.later(70, () => s.tone(1900, 0.08, "sine", 0.06));
    s.later(140, () => s.tone(2400, 0.3, "sine", 0.05, -600));
  },
  ball_pickup: (s) => {
    s.tone(700, 0.05, "triangle", 0.04);
    s.later(60, () => s.tone(1050, 0.08, "triangle", 0.04));
  },
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private readonly files = new Map<SoundEvent, string>();
  private readonly buffers = new Map<string, AudioBuffer>();
  enabled = true;
  vibration = true;
  /** Last sounds played (diagnostics / tests). */
  readonly log: SoundEvent[] = [];

  unlock(): void {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      this.ctx = null;
    }
  }

  /** Replaces the synthesized default of an event with an audio file. */
  register(name: SoundEvent, url: string): void {
    this.files.set(name, url);
  }

  later(ms: number, fn: () => void): void {
    setTimeout(fn, ms);
  }

  tone(freq: number, dur: number, type: OscillatorType, gain = 0.08, slide = 0): void {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** Filtered noise sweep (whoosh, crack). */
  noise(dur: number, gain: number, fromHz: number, toHz: number): void {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.2;
    const t = ctx.currentTime;
    f.frequency.setValueAtTime(fromHz, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(50, toHz), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(ctx.destination);
    src.start(t);
  }

  play(name: SoundEvent): void {
    this.log.push(name);
    if (this.log.length > 64) this.log.shift();
    if (!this.enabled || !this.ctx) return;
    const file = this.files.get(name);
    if (file) {
      void this.playFile(file).catch(() => RECIPES[name](this));
      return;
    }
    RECIPES[name](this);
  }

  private async playFile(url: string): Promise<void> {
    const ctx = this.ctx!;
    let buf = this.buffers.get(url);
    if (!buf) {
      buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
      this.buffers.set(url, buf);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  }

  /** Short haptic pulse on phones and gamepads (optional, setting-controlled). */
  vibrate(pattern: number | number[]): void {
    if (!this.vibration) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* not supported */
    }
    try {
      const pad = navigator.getGamepads?.().find((g) => g && (g as Gamepad & { vibrationActuator?: unknown }).vibrationActuator);
      const act = (pad as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | undefined)?.vibrationActuator;
      const ms = Array.isArray(pattern) ? pattern[0] : pattern;
      void act?.playEffect?.("dual-rumble", { duration: ms, strongMagnitude: 0.6, weakMagnitude: 0.4 })?.catch?.(() => {});
    } catch {
      /* not supported */
    }
  }
}
