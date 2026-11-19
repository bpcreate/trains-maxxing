// The whole show is one plain JSON object. The server holds the authoritative
// copy; every client holds a mirror and applies the same actions through
// reduce(), so everybody stays in step.

import { FX, FX_IDS, MOM_IDS } from './fx.js';

export const APP_NAME = 'Trains Maxxing';

export const LAYERS = ['A', 'B', 'C', 'D'];
export const DECKS = ['A', 'B'];
export const OVERLAYS = ['C', 'D'];
export const BLENDS = ['mix', 'add', 'screen', 'multiply', 'diff', 'lighten', 'key'];
export const XSTYLES = ['fade', 'cut', 'wipe', 'split'];
export const FITS = ['auto', 'fill', 'fit', 'tile', 'turn'];
export const MODES = ['loop', 'shunt', 'once'];
export const SCENE_SLOTS = 8;

function layer(over = {}) {
  return {
    src: null,        // clip id, or "live:<id>" for a live input
    cue: null,        // source waiting for GO
    seq: 0,           // bumped to restart the clip from its in-point
    on: true,         // overlays only: visible or not
    playing: true,
    rate: 1,          // -2 .. 2 (negative plays backwards)
    mode: 'loop',     // loop | shunt (back and forth) | once
    shuntBeats: 0,    // 0 = bounce at the ends, n = change direction every n beats
    in: 0,            // loop points, 0..1 of the clip
    out: 1,
    fit: 'auto',
    blend: 'screen',  // overlays only
    opacity: 1,
    key: 0.35,        // threshold for the "key" blend
    vol: 0,
    ...over,
  };
}

export function defaultState() {
  const fx = {};
  for (const f of FX) fx[f.id] = { on: false, amt: f.amt, y: f.yv };
  const mom = {};
  for (const id of MOM_IDS) mom[id] = false;
  return {
    v: 1,
    xfade: 0,             // 0 = all A, 1 = all B
    xfadeStyle: 'fade',
    abBlend: 'mix',       // how A and B combine around the middle of the slider
    master: 1,
    blackout: false,
    layers: {
      A: layer(),
      B: layer(),
      C: layer({ on: false, opacity: 0.8 }),
      D: layer({ on: false, opacity: 0.8, blend: 'add' }),
    },
    fx,
    fxSel: 'trails',
    mom,
    tempo: { bpm: 120, t0: 0, mic: false },
    auto: { on: false, chaos: 0.35, pool: 'all', live: true },
    tag: { text: '', color: '#ff2bd6', n: 0 },
    scenes: Array.from({ length: SCENE_SLOTS }, () => null),
    favs: {},
  };
}

// ---- validation for generic {type:'set'} actions ----

const num = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (list) => (v) => (list.includes(v) ? v : undefined);
const str = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);

const L = '(A|B|C|D)';
const F = `(${FX_IDS.join('|')})`;
const SPEC = [
  ['xfade', num(0, 1)],
  ['xfadeStyle', oneOf(XSTYLES)],
  ['abBlend', oneOf(BLENDS)],
  ['master', num(0, 1)],
  ['blackout', bool],
  [`layers.${L}.on`, bool],
  [`layers.${L}.playing`, bool],
  [`layers.${L}.rate`, num(-2, 2)],
  [`layers.${L}.mode`, oneOf(MODES)],
  [`layers.${L}.shuntBeats`, num(0, 16)],
  [`layers.${L}.in`, num(0, 1)],
  [`layers.${L}.out`, num(0, 1)],
  [`layers.${L}.fit`, oneOf(FITS)],
  [`layers.${L}.blend`, oneOf(BLENDS)],
  [`layers.${L}.opacity`, num(0, 1)],
  [`layers.${L}.key`, num(0, 1)],
  [`layers.${L}.vol`, num(0, 1)],
  [`fx.${F}.on`, bool],
  [`fx.${F}.amt`, num(0, 1)],
  [`fx.${F}.y`, num(0, 1)],
  ['fxSel', oneOf(FX_IDS)],
  [`mom.(${MOM_IDS.join('|')})`, bool],
  ['auto.on', bool],
  ['auto.chaos', num(0, 1)],
  ['auto.pool', str(80)],
  ['auto.live', bool],
  ['tempo.mic', bool],
].map(([p, check]) => [new RegExp(`^${p.replace(/\./g, '\\.')}$`), check]);

export function validateSet(path, value) {
  if (typeof path !== 'string') return undefined;
  for (const [re, check] of SPEC) if (re.test(path)) return check(value);
  return undefined;
}

export function getPath(obj, path) {
  let o = obj;
  for (const k of path.split('.')) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}

const validSrc = (s) => s === null || (typeof s === 'string' && s.length <= 80);

const SCENE_KEYS = ['xfade', 'xfadeStyle', 'abBlend', 'layers', 'fx'];

export function snapshotScene(state) {
  const scene = {};
  for (const k of SCENE_KEYS) scene[k] = structuredClone(state[k]);
  for (const id of LAYERS) scene.layers[id].cue = null;
  return scene;
}

function applyScene(state, scene) {
  const d = defaultState();
  if (typeof scene.xfade === 'number') state.xfade = scene.xfade;
  if (XSTYLES.includes(scene.xfadeStyle)) state.xfadeStyle = scene.xfadeStyle;
  if (BLENDS.includes(scene.abBlend)) state.abBlend = scene.abBlend;
  for (const id of LAYERS) {
    const seq = state.layers[id].seq;
    const prev = state.layers[id].src;
    state.layers[id] = { ...d.layers[id], ...(scene.layers?.[id] || {}), cue: null };
    // restart only the layers whose clip actually changed
    state.layers[id].seq = prev === state.layers[id].src ? seq : seq + 1;
  }
  for (const id of FX_IDS) state.fx[id] = { ...d.fx[id], ...(scene.fx?.[id] || {}) };
}

/**
 * Apply one action to a state object, in place.
 * Returns true when the action was valid and applied.
 */
export function reduce(state, a) {
  if (!a || typeof a.type !== 'string') return false;
  switch (a.type) {
    case 'set': {
      const v = validateSet(a.path, a.value);
      if (v === undefined) return false;
      setPath(state, a.path, v);
      // keep loop points sane
      const m = /^layers\.(A|B|C|D)\.(in|out)$/.exec(a.path);
      if (m) {
        const ly = state.layers[m[1]];
        if (ly.out - ly.in < 0.01) {
          if (m[2] === 'in') ly.in = Math.max(0, ly.out - 0.01);
          else ly.out = Math.min(1, ly.in + 0.01);
        }
      }
      return true;
    }
    case 'load': {
      const ly = state.layers[a.layer];
      if (!ly || !validSrc(a.src)) return false;
      if (a.cue) {
        ly.cue = a.src;
      } else {
        ly.src = a.src;
        ly.cue = null;
        ly.seq++;
        ly.in = 0;
        ly.out = 1;
        ly.playing = true;
        if (OVERLAYS.includes(a.layer) && a.src) ly.on = true;
      }
      return true;
    }
    case 'eject': {
      const ly = state.layers[a.layer];
      if (!ly) return false;
      ly.src = null;
      ly.cue = null;
      if (OVERLAYS.includes(a.layer)) ly.on = false;
      return true;
    }
    case 'go': {
      // launch every cued clip together
      for (const id of LAYERS) {
        const ly = state.layers[id];
        if (ly.cue == null) continue;
        ly.src = ly.cue;
        ly.cue = null;
        ly.seq++;
        ly.in = 0;
        ly.out = 1;
        ly.playing = true;
        if (OVERLAYS.includes(id)) ly.on = true;
      }
      return true;
    }
    case 'restart': {
      const ly = state.layers[a.layer];
      if (!ly) return false;
      ly.seq++;
      ly.playing = true;
      return true;
    }
    case 'retrigger': {
      for (const id of LAYERS) {
        state.layers[id].seq++;
        state.layers[id].playing = true;
      }
      return true;
    }
    case 'tempo': {
      // a.t0 is the time of a beat (a tap, a detected kick). The beat *count*
      // carries on from where it was, so nothing scheduled on beats jumps.
      const at = typeof a.t0 === 'number' && Number.isFinite(a.t0) ? a.t0 : null;
      const n = at != null ? Math.round(beatAt(state.tempo, at)) : 0;
      if (typeof a.bpm === 'number' && a.bpm >= 40 && a.bpm <= 220) state.tempo.bpm = a.bpm;
      if (at != null) state.tempo.t0 = at - (n * 60000) / state.tempo.bpm;
      return true;
    }
    case 'fav': {
      if (typeof a.id !== 'string' || a.id.length > 80) return false;
      if (state.favs[a.id]) delete state.favs[a.id];
      else state.favs[a.id] = true;
      return true;
    }
    case 'tag': {
      if (typeof a.text !== 'string') return false;
      state.tag = {
        text: a.text.slice(0, 60),
        color: typeof a.color === 'string' && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : state.tag.color,
        n: state.tag.n + 1,
      };
      return true;
    }
    case 'scene.save': {
      if (!Number.isInteger(a.i) || a.i < 0 || a.i >= SCENE_SLOTS) return false;
      state.scenes[a.i] = snapshotScene(state);
      return true;
    }
    case 'scene.clear': {
      if (!Number.isInteger(a.i) || a.i < 0 || a.i >= SCENE_SLOTS) return false;
      state.scenes[a.i] = null;
      return true;
    }
    case 'scene.load': {
      const scene = state.scenes[a.i];
      if (!scene) return false;
      applyScene(state, scene);
      return true;
    }
    default:
      return false;
  }
}

/** Merge a saved state over the defaults so old save files keep working. */
export function hydrate(saved) {
  const d = defaultState();
  if (!saved || typeof saved !== 'object') return d;
  for (const k of ['xfade', 'xfadeStyle', 'abBlend', 'master', 'fxSel']) {
    if (typeof saved[k] === typeof d[k]) d[k] = saved[k];
  }
  for (const id of LAYERS) Object.assign(d.layers[id], saved.layers?.[id] || {}, { cue: null });
  for (const id of FX_IDS) Object.assign(d.fx[id], saved.fx?.[id] || {});
  Object.assign(d.tempo, saved.tempo || {}, { mic: false });
  Object.assign(d.auto, saved.auto || {}, { on: false });
  if (Array.isArray(saved.scenes)) d.scenes = d.scenes.map((_, i) => saved.scenes[i] || null);
  if (saved.favs && typeof saved.favs === 'object') d.favs = saved.favs;
  if (saved.tag) d.tag = { ...d.tag, color: saved.tag.color || d.tag.color };
  return d;
}

// ---- beat clock helpers (tempo.t0 is a server-clock timestamp of beat 0) ----

export function beatAt(tempo, now) {
  return ((now - tempo.t0) / 60000) * tempo.bpm;
}

/** Is a layer currently contributing to the picture? */
export function layerVisible(state, id) {
  const ly = state.layers[id];
  if (!ly.src) return false;
  if (id === 'A') return state.xfadeStyle === 'cut' ? state.xfade < 0.5 : state.xfade < 0.999;
  if (id === 'B') return state.xfadeStyle === 'cut' ? state.xfade >= 0.5 : state.xfade > 0.001;
  return ly.on && ly.opacity > 0.01;
}
