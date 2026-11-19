// Tag tab: finger spray-paint on the big screen, and graffiti shout-outs.

import { h, chips, buzz, clamp } from './dom.js';

const COLORS = ['#ff2bd6', '#00e5ff', '#ffe600', '#7dff5a', '#ff5a1f', '#b56bff', '#ffffff', '#111111'];
const CAPS = [[0.012, 'Skinny'], [0.03, 'Regular'], [0.065, 'Fat cap']];

export function tagView(app) {
  const { net } = app;
  let color = COLORS[0];
  let size = CAPS[1][0];
  let strokeN = 0;

  const canvas = h('canvas', { class: 'spray-canvas' });
  const bg = h('img', { class: 'spray-bg', alt: '' });
  const pad = h('div', { class: 'spray-pad' }, bg, canvas, h('div', { class: 'spray-hint' }, 'Paint here with your finger'));
  const ctx = canvas.getContext('2d');
  let stroke = null; // { id, pts: pending points, last }

  function fitCanvas() {
    const r = pad.getBoundingClientRect();
    if (r.width && (canvas.width !== Math.round(r.width) || canvas.height !== Math.round(r.height))) {
      canvas.width = Math.round(r.width);
      canvas.height = Math.round(r.height);
    }
  }
  const point = (e) => {
    const r = pad.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
  };
  function flush(end = false) {
    if (!stroke || (!stroke.pts.length && !end)) return;
    net.send({ t: 'spray', s: { id: stroke.id, color, size, pts: stroke.pts, end } });
    stroke.pts = [];
  }
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    fitCanvas();
    pad.classList.add('used');
    const p = point(e);
    stroke = { id: `${net.you}-${strokeN++}`, pts: [p], last: p, timer: setInterval(() => flush(), 40) };
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = point(e);
    // quick local echo; the real paint shows up in the preview behind it
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, size * canvas.height * 1.6);
    ctx.beginPath();
    ctx.moveTo(stroke.last[0] * canvas.width, stroke.last[1] * canvas.height);
    ctx.lineTo(p[0] * canvas.width, p[1] * canvas.height);
    ctx.stroke();
    stroke.last = p;
    stroke.pts.push(p);
  });
  const end = () => {
    if (!stroke) return;
    clearInterval(stroke.timer);
    flush(true);
    stroke = null;
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  // the echo fades quickly: the preview image shows the lasting result
  setInterval(() => {
    if (!canvas.width || stroke) return;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }, 250);

  const swatches = COLORS.map((c) => h('button', { class: 'swatch', type: 'button', style: { background: c }, 'aria-label': `Colour ${c}`, onclick: () => { buzz(); color = c; update(); } }));
  const caps = chips({ options: CAPS, onPick: (v) => { size = v; update(); } });
  const clear = h('button', { class: 'btn danger', type: 'button', onclick: () => { buzz(20); net.send({ t: 'spray.clear' }); ctx.clearRect(0, 0, canvas.width, canvas.height); } }, 'Wipe the wall');

  const text = h('input', { class: 'tag-input', type: 'text', maxlength: '60', placeholder: 'Type a shout-out…', 'aria-label': 'Shout-out text', enterkeyhint: 'send' });
  const throwIt = () => {
    const t = text.value.trim();
    if (!t) return;
    buzz(20);
    net.act({ type: 'tag', text: t, color: color === '#111111' ? '#ffffff' : color });
    text.value = '';
    text.blur();
    app.toast('Up on the wall!');
  };
  text.addEventListener('keydown', (e) => e.key === 'Enter' && throwIt());

  const el = h('div', { class: 'view', id: 'v-tag' },
    pad,
    h('div', { class: 'swatches' }, swatches),
    h('div', { class: 'row' }, caps.el, clear),
    h('h2', {}, 'Shout-out'),
    h('div', { class: 'row' }, text, h('button', { class: 'btn go armed', type: 'button', onclick: throwIt }, 'Throw it up')),
    h('p', { class: 'note' }, 'The words land on the big screen in graffiti letters for a few seconds, in the colour picked above.'));

  function update() {
    swatches.forEach((sw, i) => sw.classList.toggle('on', COLORS[i] === color));
    caps.set(size);
  }
  return {
    el, update,
    setPreview(img) {
      if (!el.hidden) bg.src = img;
    },
  };
}
