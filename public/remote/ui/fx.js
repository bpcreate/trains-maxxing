// FX tab: hold pads, effect pads with an XY pad, tempo and master level.

import { h, slider, holdPad, buzz, clamp } from './dom.js';
import { FX, MOMENTARY } from '/shared/fx.js';
import { beatAt } from '/shared/state.js';

export function fxView(app) {
  const { net } = app;

  const holds = MOMENTARY.map((m) => ({
    id: m.id,
    pad: holdPad({ label: m.name, icon: m.icon, onChange: (v) => net.act({ type: 'set', path: `mom.${m.id}`, value: v }) }),
  }));

  const pads = FX.map((f) => {
    const el = h('button', { class: 'pad fx', type: 'button', onclick: () => {
      buzz(12);
      const cur = net.state.fx[f.id];
      // tap a lit pad that is not selected: just select it; otherwise toggle
      if (cur.on && net.state.fxSel !== f.id) net.set('fxSel', f.id);
      else {
        net.act({ type: 'set', path: `fx.${f.id}.on`, value: !cur.on });
        net.set('fxSel', f.id);
      }
    } }, h('span', { class: 'pad-icon' }, f.icon), h('span', {}, f.name));
    return { id: f.id, el };
  });

  // ---- XY pad for the selected effect ----
  const dot = h('div', { class: 'xy-dot' });
  const xLabel = h('span', { class: 'xy-x' });
  const yLabel = h('span', { class: 'xy-y' });
  const xyTitle = h('div', { class: 'xy-title' });
  const xy = h('div', { class: 'xy' }, dot, xLabel, yLabel, xyTitle);
  let dragging = false;
  const fromEvent = (e) => {
    const r = xy.getBoundingClientRect();
    const id = net.state.fxSel;
    net.set(`fx.${id}.amt`, clamp((e.clientX - r.left) / r.width, 0, 1));
    net.set(`fx.${id}.y`, clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
  };
  xy.addEventListener('pointerdown', (e) => {
    xy.setPointerCapture(e.pointerId);
    dragging = true;
    // touching the pad switches the effect on, so it always does something
    if (!net.state.fx[net.state.fxSel].on) net.act({ type: 'set', path: `fx.${net.state.fxSel}.on`, value: true });
    fromEvent(e);
    e.preventDefault();
  });
  xy.addEventListener('pointermove', (e) => dragging && fromEvent(e));
  const stop = () => (dragging = false);
  xy.addEventListener('pointerup', stop);
  xy.addEventListener('pointercancel', stop);

  const allOff = h('button', { class: 'btn', type: 'button', onclick: () => {
    buzz(20);
    for (const f of FX) if (net.state.fx[f.id].on) net.act({ type: 'set', path: `fx.${f.id}.on`, value: false });
  } }, 'All effects off');

  // ---- tempo ----
  const bpm = h('div', { class: 'bpm' });
  const tap = h('button', { class: 'btn tap', type: 'button' }, 'TAP');
  tap.addEventListener('pointerdown', (e) => {
    buzz(10);
    net.send({ t: 'tap' });
    e.preventDefault();
  });
  const scale = (k) => () => {
    buzz();
    const t = net.state.tempo;
    const v = clamp(t.bpm * k, 40, 220);
    // anchor on the most recent beat so the new tempo stays in step with the old one
    const lastBeat = t.t0 + (Math.floor(beatAt(t, net.now())) * 60000) / t.bpm;
    net.act({ type: 'tempo', bpm: Math.round(v * 10) / 10, t0: lastBeat });
  };
  const mic = h('button', { class: 'chip', type: 'button', onclick: () => { buzz(); net.set('tempo.mic', !net.state.tempo.mic); } }, '🎤 Listen');
  const master = slider({ value: 1, cls: 'master', label: 'Screen brightness', onInput: (v) => net.set('master', v) });

  const el = h('div', { class: 'view', id: 'v-fx' },
    h('h2', {}, 'Hold'),
    h('div', { class: 'pads hold-pads' }, holds.map((x) => x.pad.el)),
    h('h2', {}, 'Effects'),
    h('div', { class: 'pads' }, pads.map((p) => p.el)),
    xy,
    h('div', { class: 'row' }, allOff),
    h('h2', {}, 'Tempo'),
    h('section', { class: 'panel tempo' },
      h('div', { class: 'row' }, tap, bpm,
        h('button', { class: 'chip', type: 'button', onclick: scale(0.5) }, '÷2'),
        h('button', { class: 'chip', type: 'button', onclick: scale(2) }, '×2'),
        mic),
      h('p', { class: 'note' }, 'Tap along with the music a few times. Strobe, Beat Zoom, shunting and autopilot follow this beat. "Listen" uses the laptop microphone instead.')),
    master.el);

  function update() {
    const s = net.state;
    for (const x of holds) x.pad.show(s.mom[x.id]);
    for (const p of pads) {
      p.el.classList.toggle('on', s.fx[p.id].on);
      p.el.classList.toggle('sel', s.fxSel === p.id);
    }
    const f = FX.find((x) => x.id === s.fxSel) || FX[0];
    const v = s.fx[f.id];
    dot.style.left = `${v.amt * 100}%`;
    dot.style.top = `${(1 - v.y) * 100}%`;
    xy.classList.toggle('on', v.on);
    xLabel.textContent = `${f.x} →`;
    yLabel.textContent = `↑ ${f.y}`;
    xyTitle.textContent = `${f.icon} ${f.name}${v.on ? '' : ' (off — touch to switch on)'}`;
    bpm.textContent = `${Math.round(s.tempo.bpm)} BPM`;
    mic.classList.toggle('on', s.tempo.mic);
    master.set(s.master);
  }

  // flash the TAP button on the beat
  let lastBeat = -1;
  function frame() {
    requestAnimationFrame(frame);
    if (!el.isConnected || el.hidden) return;
    const b = Math.floor(beatAt(net.state.tempo, net.now()));
    if (b !== lastBeat) {
      lastBeat = b;
      tap.classList.remove('beat');
      void tap.offsetWidth;
      tap.classList.add('beat');
    }
  }
  requestAnimationFrame(frame);

  return { el, update };
}
