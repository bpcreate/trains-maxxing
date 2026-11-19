// Autopilot: VJs the show by itself. It runs on the server so it keeps going
// when the phone is asleep or out of Wi-Fi range. Everything it does goes
// through the same actions a phone would send.

import { beatAt } from '../shared/state.js';
import { FX_IDS } from '../shared/fx.js';

const HOLD_MS = 10000; // how long a manual touch keeps autopilot off that control
const pick = (rand, list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
const ease = (k) => k * k * (3 - 2 * k);

export class Autopilot {
  constructor({ getState, dispatch, getSources, now = Date.now, rand = Math.random }) {
    this.getState = getState;
    this.dispatch = (a) => dispatch(a, 'auto');
    this.getSources = getSources; // (pool, includeLive) -> [src, ...]
    this.now = now;
    this.rand = rand;
    this.holds = {};
    this.reset();
  }

  reset() {
    this.running = false;
    this.nextCut = null;
    this.fade = null;
    this.fxOff = [];      // [{ id, at }] effects autopilot switched on
    this.momOff = [];     // [{ id, at }]
    this.overlayOff = null;
    this.lastBar = null;
    this.lastBeat = null;
    this.recent = [];
  }

  /** The beat counter jumped (tempo re-tapped): move everything scheduled along with it. */
  _shift(d) {
    if (this.nextCut != null) this.nextCut += d;
    if (this.fade) this.fade.start += d;
    for (const f of this.fxOff) f.at += d;
    for (const m of this.momOff) m.at += d;
    if (this.overlayOff != null) this.overlayOff += d;
  }

  /** A person touched a control group: leave it alone for a while. */
  touch(group) {
    this.holds[group] = this.now() + HOLD_MS;
  }

  held(group) {
    return (this.holds[group] || 0) > this.now();
  }

  /** Map a user action to the control group it belongs to. */
  static groupOf(a) {
    if (a.type === 'set') {
      if (/^(xfade|xfadeStyle|abBlend)$/.test(a.path)) return 'xfade';
      if (/^layers\.[AB]\./.test(a.path)) return 'decks';
      if (/^layers\.[CD]\./.test(a.path)) return 'overlay';
      if (/^(fx|mom)\./.test(a.path)) return 'fx';
      return null;
    }
    if (a.type === 'load' || a.type === 'eject' || a.type === 'restart') return a.layer === 'A' || a.layer === 'B' ? 'decks' : 'overlay';
    if (a.type === 'go' || a.type === 'retrigger' || a.type === 'scene.load') return 'decks';
    return null;
  }

  tick() {
    const s = this.getState();
    if (!s.auto.on) {
      if (this.running) this.stop();
      return;
    }
    const beat = beatAt(s.tempo, this.now());
    const chaos = s.auto.chaos;
    if (!this.running) {
      this.running = true;
      this.lastBar = Math.floor(beat / 4);
      // start quickly: fill the live deck if it is empty, then cut on the next bar
      const live = s.xfade < 0.5 ? 'A' : 'B';
      if (!s.layers[live].src) this._loadRandom(live, chaos);
      this.nextCut = (Math.floor(beat / 4) + 1) * 4;
    }
    if (this.lastBeat != null && Math.abs(beat - this.lastBeat) > 2) {
      this._shift(beat - this.lastBeat);
      this.lastBar = Math.floor(beat / 4);
    }
    this.lastBeat = beat;

    // running crossfade
    if (this.fade) {
      if (this.held('xfade')) {
        this.fade = null;
        this.nextCut = Math.max(this.nextCut, beat + 8);
      } else if (beat >= this.fade.start) {
        const k = this.fade.beats <= 0 ? 1 : Math.min(1, (beat - this.fade.start) / this.fade.beats);
        const x = this.fade.from + (this.fade.to - this.fade.from) * ease(k);
        this.dispatch({ type: 'set', path: 'xfade', value: Math.round(x * 1000) / 1000 });
        if (k >= 1) this.fade = null;
      }
    }

    // things scheduled to switch off
    this.fxOff = this.fxOff.filter((f) => {
      if (beat < f.at) return true;
      if (!this.held('fx')) this.dispatch({ type: 'set', path: `fx.${f.id}.on`, value: false });
      return false;
    });
    this.momOff = this.momOff.filter((m) => {
      if (beat < m.at) return true;
      this.dispatch({ type: 'set', path: `mom.${m.id}`, value: false });
      return false;
    });
    if (this.overlayOff != null && beat >= this.overlayOff) {
      this.overlayOff = null;
      if (!this.held('overlay')) this.dispatch({ type: 'set', path: 'layers.C.on', value: false });
    }

    if (!this.fade && beat >= this.nextCut) {
      if (this.held('decks') || this.held('xfade')) this.nextCut = beat + 4;
      else this._cut(beat, chaos);
    }

    const bar = Math.floor(beat / 4);
    if (bar !== this.lastBar) {
      this.lastBar = bar;
      this._onBar(beat, chaos);
    }
  }

  stop() {
    // tidy up whatever autopilot switched on
    for (const f of this.fxOff) this.dispatch({ type: 'set', path: `fx.${f.id}.on`, value: false });
    for (const m of this.momOff) this.dispatch({ type: 'set', path: `mom.${m.id}`, value: false });
    if (this.overlayOff != null) this.dispatch({ type: 'set', path: 'layers.C.on', value: false });
    this.reset();
  }

  _pickSource(s) {
    const pool = this.getSources(s.auto.pool, s.auto.live);
    if (!pool.length) return null;
    const onAir = new Set(['A', 'B', 'C'].map((id) => s.layers[id].src));
    let fresh = pool.filter((src) => !this.recent.includes(src) && !onAir.has(src));
    if (!fresh.length) fresh = pool.filter((src) => !onAir.has(src));
    if (!fresh.length) fresh = pool;
    const src = pick(this.rand, fresh);
    this.recent.push(src);
    while (this.recent.length > Math.min(8, Math.max(0, pool.length - 2))) this.recent.shift();
    return src;
  }

  _loadRandom(layer, chaos) {
    const s = this.getState();
    const src = this._pickSource(s);
    if (!src) return false;
    this.dispatch({ type: 'load', layer, src });
    const set = (key, value) => {
      if (this.getState().layers[layer][key] !== value) this.dispatch({ type: 'set', path: `layers.${layer}.${key}`, value });
    };
    // mostly normal playback; more chaos means more speed changes and shunting
    set('rate', this.rand() < chaos * 0.35 ? pick(this.rand, [0.5, 1.5, 2, -1]) : 1);
    if (this.rand() < 0.12 + chaos * 0.4) {
      set('mode', 'shunt');
      set('shuntBeats', pick(this.rand, [0, 2, 4]));
    } else {
      set('mode', 'loop');
      set('shuntBeats', 0);
    }
    set('fit', 'auto');
    return true;
  }

  _cut(beat, chaos) {
    const s = this.getState();
    const incoming = s.xfade < 0.5 ? 'B' : 'A';
    if (!this._loadRandom(incoming, chaos)) {
      this.nextCut = beat + 8;
      return;
    }
    // choose how to get there
    const r = this.rand();
    const style = r < chaos * 0.35 ? 'cut' : r < chaos * 0.35 + 0.15 + chaos * 0.25 ? 'wipe' : 'fade';
    if (s.xfadeStyle !== style) this.dispatch({ type: 'set', path: 'xfadeStyle', value: style });
    const blend = style === 'fade' && this.rand() < chaos * 0.45 ? pick(this.rand, ['add', 'screen', 'lighten', 'diff']) : 'mix';
    if (s.abBlend !== blend) this.dispatch({ type: 'set', path: 'abBlend', value: blend });

    const fadeBeats = style === 'cut' ? 0 : chaos < 0.3 ? 8 : chaos < 0.65 ? 4 : 2;
    // two beats of lead time so the stage can load the incoming clip
    this.fade = { from: s.xfade, to: incoming === 'B' ? 1 : 0, start: beat + 2, beats: fadeBeats };

    const bars = pick(this.rand, chaos < 0.2 ? [8, 8, 6] : chaos < 0.45 ? [8, 4, 4] : chaos < 0.7 ? [4, 2, 2] : [2, 1, 1]);
    this.nextCut = (Math.floor((beat + 2 + fadeBeats) / 4) + bars) * 4;
  }

  _onBar(beat, chaos) {
    const s = this.getState();

    // effects come and go
    if (!this.held('fx')) {
      const max = Math.round(chaos * 3);
      if (this.fxOff.length < max && this.rand() < 0.12 + chaos * 0.45) {
        const off = FX_IDS.filter((id) => !s.fx[id].on);
        if (off.length) {
          const id = pick(this.rand, off);
          this.dispatch({ type: 'set', path: `fx.${id}.amt`, value: Math.round((0.2 + this.rand() * 0.6) * 100) / 100 });
          this.dispatch({ type: 'set', path: `fx.${id}.on`, value: true });
          this.fxOff.push({ id, at: beat + pick(this.rand, [4, 8, 8, 16]) });
        }
      }
      // short stabs at high chaos
      if (chaos > 0.6 && this.rand() < (chaos - 0.5) * 0.5) {
        const id = pick(this.rand, ['strobe', 'glitch', 'invert']);
        this.dispatch({ type: 'set', path: `mom.${id}`, value: true });
        this.momOff.push({ id, at: beat + pick(this.rand, [0.5, 1, 1]) });
      }
    }

    // an overlay now and then
    if (chaos > 0.25 && this.overlayOff == null && !this.held('overlay') && this.rand() < chaos * 0.22) {
      const src = this._pickSource(s);
      if (src) {
        this.dispatch({ type: 'load', layer: 'C', src });
        this.dispatch({ type: 'set', path: 'layers.C.blend', value: pick(this.rand, ['screen', 'add', 'lighten', 'key']) });
        this.dispatch({ type: 'set', path: 'layers.C.opacity', value: Math.round((0.4 + this.rand() * 0.4) * 100) / 100 });
        this.overlayOff = beat + pick(this.rand, [16, 16, 32]);
      }
    }
  }
}
