// Tap tempo: turns a run of taps into a BPM and a beat-zero timestamp.

export class TapTempo {
  constructor() {
    this.taps = [];
  }

  /** Register a tap at time `now` (ms). Returns {bpm?, t0}. */
  tap(now) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    const out = { t0: now };
    if (this.taps.length >= 2) {
      const span = now - this.taps[0];
      const bpm = 60000 / (span / (this.taps.length - 1));
      if (bpm >= 40 && bpm <= 220) out.bpm = Math.round(bpm * 10) / 10;
    }
    return out;
  }
}
