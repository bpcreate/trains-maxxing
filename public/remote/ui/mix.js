// Mix tab: the two decks, how they blend, GO, and the two overlay layers.

import { h, slider, chips, buzz, clamp, fmtTime } from './dom.js';
import { LAYERS } from '/shared/state.js';

const BLEND_OPTS = [['mix', 'Mix'], ['add', 'Add'], ['screen', 'Screen'], ['multiply', 'Multiply'], ['diff', 'Diff'], ['lighten', 'Lighten'], ['key', 'Cut-out']];
const FIT_OPTS = [['auto', 'Auto'], ['fill', 'Fill'], ['fit', 'Fit'], ['tile', 'Tile'], ['turn', 'Turn']];
const STYLE_OPTS = [['fade', 'Fade'], ['cut', 'Cut'], ['wipe', 'Train wipe'], ['split', 'Split']];
const SCRUB_WINDOW = 12; // a full-width swipe moves the clip by at most this many seconds

/** Describe a source id ("clipid" or "live:x") for display. */
export function describe(app, src) {
  if (!src) return null;
  if (src.startsWith('live:')) {
    const live = app.net.lives.find((l) => l.src === src);
    return { name: live ? live.name : 'Live input (gone)', thumb: app.liveThumbs[src.slice(5)] || null, live: true, strip: null, dur: 0 };
  }
  const c = app.net.clipsById.get(src);
  return c ? { name: c.name, thumb: c.thumb, strip: c.strip, dur: c.dur, prep: c.prep } : { name: 'Missing clip', thumb: null, strip: null, dur: 0 };
}

/** The scratch rail: a filmstrip you drag to move the clip back and forth. */
function jogRail(app, id) {
  const head = h('div', { class: 'jog-head' });
  const range = h('div', { class: 'jog-range' });
  const hint = h('div', { class: 'jog-hint' }, '◀ drag to scratch ▶');
  const el = h('div', { class: 'jog' }, range, head, hint);
  let drag = null;
  let localPos = null;
  let lastSend = 0;

  const info = () => app.pos[id] || { p: 0, d: 0 };
  const send = (pos, extra = {}) => app.net.send({ t: 'jog', l: id, pos, ...extra });

  el.addEventListener('pointerdown', (e) => {
    const src = app.net.state.layers[id].src;
    if (!src || src.startsWith('live:')) return;
    el.setPointerCapture(e.pointerId);
    const p = info().p;
    drag = { x: e.clientX, start: p, moved: false, t: performance.now(), samples: [[performance.now(), p]] };
    localPos = p;
    el.classList.add('drag');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (!drag.moved) return;
    const d = info().d || 1;
    const scale = Math.min(1, SCRUB_WINDOW / d);
    localPos = clamp(drag.start + (dx / r.width) * scale, 0, 1);
    const now = performance.now();
    drag.samples.push([now, localPos]);
    if (drag.samples.length > 6) drag.samples.shift();
    if (now - lastSend > 30) {
      lastSend = now;
      send(localPos);
    }
    paint();
  });
  const end = (e) => {
    if (!drag) return;
    const r = el.getBoundingClientRect();
    if (!drag.moved && performance.now() - drag.t < 350) {
      // a tap jumps straight to that spot
      localPos = clamp((e.clientX - r.left) / r.width, 0, 1);
      send(localPos);
      send(localPos, { end: true, vel: 0 });
      buzz();
    } else {
      // speed of the last few moments: a flick throws the clip
      const s = drag.samples;
      const first = s[0];
      const lastS = s[s.length - 1];
      const dt = (lastS[0] - first[0]) / 1000;
      const stale = performance.now() - lastS[0] > 80;
      const vel = dt > 0.01 && !stale ? (lastS[1] - first[1]) / dt : 0;
      send(localPos, { end: true, vel });
    }
    drag = null;
    el.classList.remove('drag');
    setTimeout(() => {
      if (!drag) localPos = null;
    }, 400);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  function paint() {
    const ly = app.net.state.layers[id];
    const p = localPos != null ? localPos : info().p;
    head.style.left = `${p * 100}%`;
    range.style.left = `${ly.in * 100}%`;
    range.style.right = `${(1 - ly.out) * 100}%`;
    range.classList.toggle('whole', ly.in <= 0.001 && ly.out >= 0.999);
  }
  let strip = null;
  function update() {
    const d = describe(app, app.net.state.layers[id].src);
    const s = d?.strip || null;
    if (s !== strip) {
      strip = s;
      el.style.backgroundImage = s ? `url(${s})` : 'none';
    }
    el.classList.toggle('disabled', !d || d.live);
    hint.textContent = !d ? 'no clip' : d.live ? 'live input' : '◀ drag to scratch ▶';
    paint();
  }
  return { el, update, paint };
}

function deckCard(app, id) {
  const { net } = app;
  const overlay = id === 'C' || id === 'D';
  const path = (k) => `layers.${id}.${k}`;
  const L = () => net.state.layers[id];
  const set = (k, v) => net.set(path(k), v);

  // ---- header ----
  const thumb = h('img', { class: 'deck-thumb', alt: '' });
  const name = h('div', { class: 'deck-name' });
  const sub = h('div', { class: 'deck-sub' });
  const pick = h('button', { class: 'deck-pick', type: 'button', onclick: () => app.pickFor(id) },
    h('span', { class: `deck-letter l${id}` }, id), thumb, h('div', { class: 'deck-text' }, name, sub));
  const onBtn = overlay
    ? h('button', { class: 'switch', type: 'button', 'aria-label': `Overlay ${id} on/off`, onclick: () => { buzz(); set('on', !L().on); } }, h('i'))
    : null;
  const moreBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More controls', onclick: () => { open = !open; update(); } }, '⋯');
  const head = h('div', { class: 'deck-head' }, pick, onBtn, moreBtn);

  // ---- transport ----
  const jog = jogRail(app, id);
  const revBtn = h('button', { class: 'tbtn', type: 'button', 'aria-label': 'Reverse', onclick: () => { buzz(); set('rate', -(L().rate || 1)); } }, '◀◀');
  const playBtn = h('button', { class: 'tbtn play', type: 'button', 'aria-label': 'Play / pause', onclick: () => { buzz(); set('playing', !L().playing); } });
  const shuntBtn = h('button', { class: 'tbtn', type: 'button', 'aria-label': 'Shunt back and forth', onclick: () => { buzz(); set('mode', L().mode === 'shunt' ? 'loop' : 'shunt'); } }, '⇄');
  const speed = slider({
    min: 0, max: 2, value: 1, snaps: [0.5, 1, 1.5], cls: 'speed', label: '1×',
    onInput: (v) => set('rate', (L().rate < 0 ? -1 : 1) * Math.max(0.05, Math.round(v * 100) / 100)),
  });
  const transport = h('div', { class: 'transport' }, revBtn, playBtn, shuntBtn, speed.el);

  // ---- overlay basics ----
  const opacity = slider({ value: 1, cls: 'opacity', label: overlay ? 'Strength' : 'Brightness', onInput: (v) => set('opacity', v) });
  const blend = overlay ? chips({ options: BLEND_OPTS.slice(1).concat([['mix', 'Solid']]), onPick: (v) => set('blend', v), cls: 'scroll' }) : null;

  // ---- more ----
  const fit = chips({ options: FIT_OPTS, onPick: (v) => set('fit', v) });
  const mode = chips({ options: [['loop', 'Loop'], ['shunt', 'Shunt'], ['once', 'Once']], onPick: (v) => set('mode', v) });
  const shuntBeats = chips({ options: [[0, 'At the ends'], [1, '1 beat'], [2, '2 beats'], [4, '4 beats']], onPick: (v) => set('shuntBeats', v) });
  const key = slider({ value: 0.35, cls: 'key', label: 'Cut-out level', onInput: (v) => set('key', v) });
  const vol = slider({ value: 0, cls: 'vol', label: 'Clip sound', onInput: (v) => set('vol', v) });
  const pos = () => (app.pos[id] || { p: 0 }).p;
  const more = h('div', { class: 'deck-more' },
    h('label', {}, 'Picture fit'), fit.el,
    h('label', {}, 'Loop part of the clip'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); set('in', Math.min(pos(), L().out - 0.01)); } }, 'Start here'),
      h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); set('out', Math.max(pos(), L().in + 0.01)); } }, 'End here'),
      h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); set('in', 0); set('out', 1); } }, 'Whole clip')),
    h('label', {}, 'Playback'), mode.el,
    h('label', {}, 'Shunt turns round'), shuntBeats.el,
    overlay ? null : opacity.el,
    key.el,
    vol.el,
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); net.act({ type: 'restart', layer: id }); } }, '⟲ Restart clip'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { buzz(); net.act({ type: 'eject', layer: id }); } }, 'Remove clip')));

  const el = h('section', { class: `deck l${id}${overlay ? ' overlay' : ''}` }, head,
    overlay ? h('div', { class: 'overlay-basic' }, opacity.el, blend.el) : null,
    jog.el, transport, more);

  let open = false;
  let thumbSrc = null;

  function update() {
    const ly = L();
    const d = describe(app, ly.src);
    const cue = describe(app, ly.cue);
    el.classList.toggle('empty', !d);
    el.classList.toggle('open', open);
    el.classList.toggle('off', overlay && !ly.on);
    el.classList.toggle('compact', overlay && !open);
    const t = d?.thumb || null;
    if (t !== thumbSrc) {
      thumbSrc = t;
      if (t) thumb.src = t;
      else thumb.removeAttribute('src');
    }
    name.textContent = d ? d.name : overlay ? `Overlay ${id}` : `Deck ${id}`;
    const st = app.pos[id];
    const loading = d && st && !st.ok;
    sub.textContent = cue ? `Next: ${cue.name} — press GO`
      : !d ? 'Tap to choose a clip'
      : loading ? 'Loading…'
      : d.live ? 'Live' : `${fmtTime((st?.p || 0) * (st?.d || d.dur))} / ${fmtTime(st?.d || d.dur)}`;
    sub.classList.toggle('cue', !!cue);
    onBtn?.classList.toggle('on', ly.on);
    revBtn.classList.toggle('on', ly.rate < 0);
    playBtn.textContent = ly.playing ? '❚❚' : '▶';
    playBtn.classList.toggle('on', ly.playing);
    shuntBtn.classList.toggle('on', ly.mode === 'shunt');
    speed.set(Math.abs(ly.rate));
    speed.setLabel(`${ly.rate < 0 ? '−' : ''}${Math.abs(ly.rate).toFixed(2).replace(/\.?0+$/, '')}×`);
    opacity.set(ly.opacity);
    blend?.set(ly.blend);
    fit.set(ly.fit);
    mode.set(ly.mode);
    shuntBeats.set(ly.shuntBeats);
    key.set(ly.key);
    vol.set(ly.vol);
    jog.update();
  }
  /** Cheap refresh for the 5-times-a-second position reports. */
  function updatePos() {
    jog.paint();
    const ly = L();
    if (ly.cue || !ly.src) return;
    const st = app.pos[id];
    const d = describe(app, ly.src);
    if (!d || !st) return;
    sub.textContent = !st.ok ? 'Loading…' : d.live ? 'Live' : `${fmtTime(st.p * st.d)} / ${fmtTime(st.d)}`;
  }
  return { el, update, updatePos };
}

export function mixView(app) {
  const { net } = app;
  const cards = {};
  for (const id of LAYERS) cards[id] = deckCard(app, id);

  const blend = chips({ options: BLEND_OPTS, onPick: (v) => net.set('abBlend', v), cls: 'scroll' });
  const style = chips({ options: STYLE_OPTS, onPick: (v) => net.set('xfadeStyle', v) });
  const go = h('button', { class: 'btn go', type: 'button', onclick: () => { buzz(20); net.act({ type: 'go' }); } }, 'GO');
  const retrig = h('button', { class: 'btn', type: 'button', onclick: () => { buzz(20); net.act({ type: 'retrigger' }); } }, '⟲ Restart all together');
  const blendNote = h('p', { class: 'note' });

  const el = h('div', { class: 'view', id: 'v-mix' },
    cards.A.el, cards.B.el,
    h('section', { class: 'panel' },
      h('label', {}, 'How A and B meet in the middle'), blend.el, blendNote,
      h('label', {}, 'Slider style'), style.el,
      h('div', { class: 'row' }, go, retrig)),
    h('h2', {}, 'Overlays'),
    h('p', { class: 'note' }, 'Extra layers on top of everything. The slider does not touch them.'),
    cards.C.el, cards.D.el);

  const NOTES = {
    mix: 'A plain crossfade.',
    add: 'In the middle both clips glow on top of each other.',
    screen: 'In the middle both clips show, bright parts win.',
    multiply: 'In the middle the dark parts of both clips win.',
    diff: 'In the middle the clips cancel into wild colours.',
    lighten: 'In the middle the brighter clip wins, pixel by pixel.',
    key: 'In the middle, B’s bright parts float over A.',
  };

  function update() {
    const s = net.state;
    for (const id of LAYERS) cards[id].update();
    blend.set(s.abBlend);
    style.set(s.xfadeStyle);
    blendNote.textContent = s.xfadeStyle === 'fade' || s.xfadeStyle === 'cut' ? NOTES[s.abBlend] : 'Blending applies to Fade and Cut styles.';
    const cues = LAYERS.filter((id) => s.layers[id].cue).length;
    go.textContent = cues ? `GO  (${cues} waiting)` : 'GO';
    go.classList.toggle('armed', cues > 0);
    go.disabled = cues === 0;
  }
  function updatePos() {
    for (const id of LAYERS) cards[id].updatePos();
  }
  return { el, update, updatePos };
}
