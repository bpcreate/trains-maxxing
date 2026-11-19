// Small DOM helpers and touch widgets for the phone remote.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function buzz(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch { /* not supported */ }
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

/**
 * Horizontal touch slider.
 *  - relative: dragging moves the value by the distance dragged (no jump on touch)
 *  - snaps: values the thumb sticks to
 * Returns { el, set(value), dragging }.
 */
export function slider({ min = 0, max = 1, value = 0, onInput, onEnd, snaps = [], relative = false, cls = '', label = '' }) {
  const fill = h('div', { class: 'sl-fill' });
  const thumb = h('div', { class: 'sl-thumb' });
  const text = h('span', { class: 'sl-label' }, label);
  const el = h('div', { class: `slider ${cls}`, role: 'slider', 'aria-label': label || cls }, fill, thumb, text);
  const api = { el, dragging: false, value, set, setLabel: (t) => (text.textContent = t) };
  const span = max - min;

  function paint(v) {
    const k = clamp((v - min) / span, 0, 1);
    el.style.setProperty('--k', k);
  }
  function set(v) {
    api.value = v;
    if (!api.dragging) paint(v);
  }
  let start = null;
  function fromEvent(e) {
    const r = el.getBoundingClientRect();
    const pad = 14; // keep the thumb fully inside the track
    let v;
    if (relative && start) v = start.v + ((e.clientX - start.x) / (r.width - pad * 2)) * span;
    else v = min + ((e.clientX - r.left - pad) / (r.width - pad * 2)) * span;
    v = clamp(v, min, max);
    for (const s of snaps) if (Math.abs(v - s) < span * 0.035) v = s;
    return v;
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    api.dragging = true;
    el.classList.add('drag');
    start = { x: e.clientX, v: api.value };
    if (!relative) {
      const v = fromEvent(e);
      api.value = v;
      paint(v);
      onInput?.(v);
    }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!api.dragging) return;
    const v = fromEvent(e);
    api.value = v;
    paint(v);
    onInput?.(v);
  });
  const end = () => {
    if (!api.dragging) return;
    api.dragging = false;
    el.classList.remove('drag');
    start = null;
    onEnd?.(api.value);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  paint(value);
  return api;
}

/** Row of mutually exclusive buttons. options: [[value, label], ...] */
export function chips({ options, onPick, cls = '' }) {
  const buttons = options.map(([value, label]) =>
    h('button', { class: 'chip', type: 'button', onclick: () => { buzz(); onPick(value); } }, label));
  const el = h('div', { class: `chips ${cls}` }, buttons);
  return {
    el,
    set(value) {
      options.forEach(([v], i) => buttons[i].classList.toggle('on', v === value));
    },
  };
}

/** A pad that is "on" only while a finger is on it. */
export function holdPad({ label, icon, onChange, cls = '' }) {
  const el = h('button', { class: `pad hold ${cls}`, type: 'button' }, h('span', { class: 'pad-icon' }, icon), h('span', {}, label));
  let down = false;
  const set = (v) => {
    if (down === v) return;
    down = v;
    el.classList.toggle('on', v);
    if (v) buzz(12);
    onChange(v);
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    set(true);
    e.preventDefault();
  });
  el.addEventListener('pointerup', () => set(false));
  el.addEventListener('pointercancel', () => set(false));
  el.addEventListener('lostpointercapture', () => set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return { el, show: (v) => { if (!down) el.classList.toggle('on', v); } };
}

/** Fire `fn` after a long press. */
export function onLongPress(el, fn, ms = 600) {
  let t = null;
  let fired = false;
  el.addEventListener('pointerdown', () => {
    fired = false;
    t = setTimeout(() => {
      fired = true;
      buzz(25);
      fn();
    }, ms);
  });
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  // swallow the click that follows a long press
  el.addEventListener('click', (e) => {
    if (fired) {
      e.stopImmediatePropagation();
      e.preventDefault();
      fired = false;
    }
  }, true);
}
