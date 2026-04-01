/**
 * SoundFX — Procedural audio engine for pixel office
 *
 * Generates all sounds via Web Audio API oscillators.
 * No audio files needed. All sounds are synthesized at runtime.
 *
 * Sound palette:
 * - typing:    soft click per keystroke
 * - spawn:     rising chime for sub-agent materialization
 * - despawn:   descending tone for sub-agent dissolution
 * - notify:    gentle ping for message / waiting_input
 * - click:     UI button press
 * - place:     furniture placement thud
 * - pickup:    furniture pickup blip
 * - ambience:  looping low hum (toggleable)
 */

export type SoundName =
  | 'typing'
  | 'typing-batch'
  | 'spawn'
  | 'despawn'
  | 'notify'
  | 'click'
  | 'place'
  | 'pickup'
  | 'error'
  | 'footstep';

class SoundFX {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private _muted = false;
  private _volume = 0.4;
  private ambienceOsc: OscillatorNode | null = null;
  private ambienceGain: GainNode | null = null;
  private _ambienceOn = false;

  /** Lazy-init AudioContext (browser requires user gesture) */
  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  private gain(): GainNode {
    this.ensureCtx();
    return this.masterGain!;
  }

  // ── Public API ──────────────────────────────────────

  get muted() { return this._muted; }
  get volume() { return this._volume; }
  get ambienceOn() { return this._ambienceOn; }

  setMuted(m: boolean) {
    this._muted = m;
    if (this.masterGain) this.masterGain.gain.value = m ? 0 : this._volume;
  }

  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && !this._muted) this.masterGain.gain.value = this._volume;
  }

  toggleAmbience() {
    if (this._ambienceOn) this.stopAmbience();
    else this.startAmbience();
  }

  // ── Sound implementations ───────────────────────────

  /** Soft mechanical click — one keystroke */
  typing() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    // Randomize pitch slightly for natural feel
    osc.frequency.value = 800 + Math.random() * 600;
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /** Rapid burst of typing clicks */
  typingBatch(count = 5) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => this.typing(), i * (40 + Math.random() * 60));
    }
  }

  /** Rising sparkle chime — sub-agent appears */
  spawn() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    // Three ascending tones (C5 → E5 → G5)
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t + i * 0.1;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.15, start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      osc.connect(g);
      g.connect(this.gain());
      osc.start(start);
      osc.stop(start + 0.35);
    });
  }

  /** Descending tone — sub-agent fades out */
  despawn() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.4);
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.45);
  }

  /** Gentle notification ping — agent sends message or enters waiting_input */
  notify() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.3);

    // Second harmonic for richness
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 1320;
    g2.gain.setValueAtTime(0.06, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc2.connect(g2);
    g2.connect(this.gain());
    osc2.start(t);
    osc2.stop(t + 0.25);
  }

  /** Short UI click — button press */
  click() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1000;
    g.gain.setValueAtTime(0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Furniture placement — satisfying thud */
  place() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    // Low thud
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.2);

    // High click on top
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'square';
    osc2.frequency.value = 400;
    g2.gain.setValueAtTime(0.05, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc2.connect(g2);
    g2.connect(this.gain());
    osc2.start(t);
    osc2.stop(t + 0.04);
  }

  /** Furniture pickup — light blip */
  pickup() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, t);
    osc.frequency.exponentialRampToValueAtTime(800, t + 0.08);
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /** Error buzz */
  error() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 200;
    g.gain.setValueAtTime(0.1, t);
    g.gain.setValueAtTime(0, t + 0.05);
    g.gain.setValueAtTime(0.1, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Soft footstep — character moves one tile */
  footstep() {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 120 + Math.random() * 40;
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g);
    g.connect(this.gain());
    osc.start(t);
    osc.stop(t + 0.08);
  }

  // ── Ambience ────────────────────────────────────────

  /** Low filtered hum — ambient office atmosphere */
  private startAmbience() {
    const ctx = this.ensureCtx();
    if (this.ambienceOsc) this.stopAmbience();

    // Low hum oscillator
    this.ambienceOsc = ctx.createOscillator();
    this.ambienceGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    this.ambienceOsc.type = 'sine';
    this.ambienceOsc.frequency.value = 60;
    filter.type = 'lowpass';
    filter.frequency.value = 120;
    this.ambienceGain.gain.value = 0.03;

    this.ambienceOsc.connect(filter);
    filter.connect(this.ambienceGain);
    this.ambienceGain.connect(this.gain());
    this.ambienceOsc.start();
    this._ambienceOn = true;
  }

  private stopAmbience() {
    if (this.ambienceOsc) {
      try { this.ambienceOsc.stop(); } catch {}
      this.ambienceOsc.disconnect();
      this.ambienceOsc = null;
    }
    if (this.ambienceGain) {
      this.ambienceGain.disconnect();
      this.ambienceGain = null;
    }
    this._ambienceOn = false;
  }
}

// Singleton — imported everywhere
export const sfx = new SoundFX();
