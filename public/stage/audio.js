// Optional beat detection from the laptop microphone. Listens to the bass,
// spots kicks, and works out tempo and phase from the gaps between them.

export class BeatListener {
  constructor(onTempo) {
    this.onTempo = onTempo; // ({ bpm, t0 }) with t0 on the local clock
    this.active = false;
    this.onsets = [];
    this.avg = 0;
    this.lastOnset = 0;
    this.lastSent = 0;
  }

  async start() {
    if (this.active) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return false;
    }
    this.ac = new AudioContext();
    const src = this.ac.createMediaStreamSource(this.stream);
    this.an = this.ac.createAnalyser();
    this.an.fftSize = 1024;
    this.an.smoothingTimeConstant = 0.3;
    src.connect(this.an);
    this.bins = new Uint8Array(this.an.frequencyBinCount);
    this.active = true;
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.stream.getTracks().forEach((t) => t.stop());
    this.ac.close();
    this.onsets = [];
  }

  /** Call every frame. */
  tick() {
    if (!this.active) return;
    this.an.getByteFrequencyData(this.bins);
    // bass energy: roughly 40-170 Hz
    let e = 0;
    for (let i = 1; i <= 4; i++) e += this.bins[i];
    e /= 4 * 255;
    this.avg = this.avg * 0.95 + e * 0.05;
    const now = Date.now();
    if (e > 0.25 && e > this.avg * 1.35 && now - this.lastOnset > 260) {
      this.lastOnset = now;
      this.onsets.push(now);
      if (this.onsets.length > 16) this.onsets.shift();
      this._estimate(now);
    }
  }

  _estimate(now) {
    if (this.onsets.length < 6 || now - this.lastSent < 2000) return;
    const gaps = [];
    for (let i = 1; i < this.onsets.length; i++) {
      let g = this.onsets[i] - this.onsets[i - 1];
      // fold missed or doubled kicks into the 75-170 BPM range
      while (g > 800) g /= 2;
      while (g < 353) g *= 2;
      gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    const close = gaps.filter((g) => Math.abs(g - median) < median * 0.08);
    if (close.length < gaps.length * 0.6) return; // not steady enough to trust
    const period = close.reduce((a, b) => a + b, 0) / close.length;
    this.lastSent = now;
    this.onTempo({ bpm: Math.round((60000 / period) * 10) / 10, t0: this.lastOnset });
  }
}
