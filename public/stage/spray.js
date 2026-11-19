// Spray-paint layer: strokes drawn on the phone land here as paint with
// speckle and drips, then slowly fade.

export class Spray {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.last = new Map();  // stroke id -> last point
    this.drips = [];
    this.lastPaint = 0;
    this.dirty = false;
    this.resize();
    setInterval(() => this._fade(), 1000);
  }

  resize() {
    const w = Math.round(this.canvas.clientWidth);
    const h = Math.round(this.canvas.clientHeight);
    if (w === this.canvas.width && h === this.canvas.height) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drips = [];
    this.dirty = false;
  }

  _fade() {
    if (!this.dirty) return;
    const idle = performance.now() - this.lastPaint;
    if (idle > 90000) return this.clear(); // sweep away the last faint ghosts
    if (idle < 15000) return;              // fresh paint stays crisp for a while
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.restore();
  }

  _dab(x, y, r, color) {
    const c = this.ctx;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(0.55, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.globalAlpha = 0.5;
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    // overspray speckle
    c.globalAlpha = 0.5;
    c.fillStyle = color;
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.8 + Math.random() * 1.1);
      c.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1.6, 1.6);
    }
    c.globalAlpha = 1;
  }

  /** s = { id, color, size (fraction of height), pts: [[x,y]...] in 0..1, end } */
  stroke(s) {
    if (!s || !Array.isArray(s.pts)) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const color = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#ff2bd6';
    const r = Math.max(3, Math.min(0.12, +s.size || 0.03) * H);
    let prev = this.last.get(s.id) || null;
    for (const pt of s.pts.slice(0, 200)) {
      const x = pt[0] * W;
      const y = pt[1] * H;
      if (!prev) {
        this._dab(x, y, r, color);
      } else {
        const dist = Math.hypot(x - prev.x, y - prev.y);
        const steps = Math.max(1, Math.ceil(dist / (r * 0.35)));
        for (let i = 1; i <= steps; i++) {
          this._dab(prev.x + ((x - prev.x) * i) / steps, prev.y + ((y - prev.y) * i) / steps, r, color);
        }
        // lingering makes it drip
        if (dist < r * 0.5 && Math.random() < 0.08 && this.drips.length < 40) {
          this.drips.push({ x: x + (Math.random() - 0.5) * r, y, left: r * (2 + Math.random() * 7), w: Math.max(2, r * 0.22), color });
        }
      }
      prev = { x, y };
    }
    if (s.end) this.last.delete(s.id);
    else this.last.set(s.id, prev);
    if (this.last.size > 50) this.last.clear();
    this.lastPaint = performance.now();
    this.dirty = true;
  }

  /** Animate drips; call every frame. */
  tick(dt) {
    if (!this.drips.length) return;
    const c = this.ctx;
    for (const d of this.drips) {
      const step = Math.min(d.left, 60 * dt);
      c.globalAlpha = 0.85;
      c.fillStyle = d.color;
      c.fillRect(d.x - d.w / 2, d.y, d.w, step + 1);
      d.y += step;
      d.left -= step;
    }
    c.globalAlpha = 1;
    this.drips = this.drips.filter((d) => d.left > 0.5);
  }
}
