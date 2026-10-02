/** Tiny synthesized sound effects (no audio assets needed). Unlocked on first user gesture. */
export class Sfx {
  private ctx: AudioContext | null = null;
  enabled = true;

  unlock(): void {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
    } catch {
      this.ctx = null;
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain = 0.08, slide = 0): void {
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

  play(name: "hit" | "super" | "faint" | "capture" | "level" | "ui" | "throw"): void {
    switch (name) {
      case "hit":
        return this.tone(180, 0.12, "square", 0.06, -80);
      case "super":
        this.tone(220, 0.1, "square", 0.07, -100);
        return this.tone(330, 0.16, "sawtooth", 0.05, -150);
      case "faint":
        return this.tone(400, 0.6, "triangle", 0.07, -320);
      case "capture":
        this.tone(660, 0.12, "square", 0.05);
        setTimeout(() => this.tone(880, 0.12, "square", 0.05), 120);
        return void setTimeout(() => this.tone(1320, 0.25, "square", 0.05), 240);
      case "level":
        this.tone(523, 0.1, "triangle", 0.07);
        setTimeout(() => this.tone(659, 0.1, "triangle", 0.07), 100);
        return void setTimeout(() => this.tone(784, 0.22, "triangle", 0.07), 200);
      case "throw":
        return this.tone(300, 0.25, "sine", 0.05, 500);
      case "ui":
        return this.tone(880, 0.05, "sine", 0.03);
    }
  }
}
