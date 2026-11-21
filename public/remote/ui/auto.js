// Auto tab: autopilot, saved scenes, and how to connect live inputs.

import { h, slider, buzz, onLongPress } from './dom.js';
import { SCENE_SLOTS } from '../../shared/state.js';

export function autoView(app) {
  const { net } = app;
  let saveArmed = false;

  const toggle = h('button', { class: 'auto-big', type: 'button', onclick: () => { buzz(25); net.set('auto.on', !net.state.auto.on); } });
  const chaos = slider({ value: 0.35, cls: 'chaos', label: '', onInput: (v) => net.set('auto.chaos', v) });
  const pool = h('div', { class: 'chips scroll' });
  const liveBtn = h('button', { class: 'chip', type: 'button', onclick: () => { buzz(); net.set('auto.live', !net.state.auto.live); } }, 'Use live inputs too');
  const poolNote = h('p', { class: 'note' });

  const slots = Array.from({ length: SCENE_SLOTS }, (_, i) => {
    const b = h('button', { class: 'scene', type: 'button', onclick: () => {
      buzz(15);
      if (saveArmed || !net.state.scenes[i]) {
        net.act({ type: 'scene.save', i });
        saveArmed = false;
        app.toast(`Look saved in slot ${i + 1}`);
      } else {
        net.act({ type: 'scene.load', i });
      }
      update();
    } });
    onLongPress(b, () => {
      if (net.state.scenes[i] && confirm(`Empty slot ${i + 1}?`)) net.act({ type: 'scene.clear', i });
    });
    return b;
  });
  const saveBtn = h('button', { class: 'btn', type: 'button', onclick: () => { buzz(); saveArmed = !saveArmed; update(); } });

  const kaleidoQr = h('img', { class: 'qr', alt: 'QR code for the kaleidoscope page' });
  const kaleidoUrl = h('code', { class: 'url' });
  const liveList = h('p', { class: 'note' });
  fetch(`${net.base}/api/info?k=${encodeURIComponent(net.key)}`).then((r) => r.json()).then((info) => {
    kaleidoQr.src = `${net.base}/api/qr/kaleido.svg?k=${encodeURIComponent(net.key)}`;
    kaleidoUrl.textContent = info.urls.kaleido;
  }).catch(() => {});

  const el = h('div', { class: 'view', id: 'v-auto' },
    toggle,
    h('section', { class: 'panel' },
      h('div', { class: 'chaos-ends' }, h('span', {}, '😌 Chill'), h('span', {}, 'Chaos 🤯')),
      chaos.el,
      h('label', {}, 'Autopilot picks from'), pool, poolNote,
      h('div', { class: 'row' }, liveBtn),
      h('p', { class: 'note' }, 'Autopilot keeps running on the laptop even if your phone sleeps. Touch any control and it leaves that control alone for ten seconds.')),
    h('h2', {}, 'Saved looks'),
    h('div', { class: 'scenes' }, slots),
    h('div', { class: 'row' }, saveBtn),
    h('p', { class: 'note' }, 'A look remembers the clips, slider, blending and effects. Tap an empty slot to save; hold a slot to empty it.'),
    h('h2', {}, 'Live inputs'),
    h('section', { class: 'panel live-info' },
      h('p', { class: 'note' }, 'Open this on the iPad for the kaleidoscope (or on any phone to use its camera). The first time, Safari shows a "not private" warning: tap Show Details, then Visit Website.'),
      h('div', { class: 'row' }, kaleidoQr, kaleidoUrl),
      liveList));

  function update() {
    const s = net.state;
    toggle.classList.toggle('on', s.auto.on);
    toggle.replaceChildren(h('b', {}, s.auto.on ? 'AUTOPILOT IS ON' : 'AUTOPILOT'), h('span', {}, s.auto.on ? 'Tap to take over' : 'Tap and it mixes by itself'));
    chaos.set(s.auto.chaos);
    liveBtn.classList.toggle('on', s.auto.live);
    const crates = [...new Set(net.clips.map((c) => c.crate).filter(Boolean))].sort();
    const opts = [['all', 'Everything'], ['fav', '★ Favourites'], ...crates.map((c) => [`crate:${c}`, c])];
    pool.replaceChildren(...opts.map(([v, label]) =>
      h('button', { class: 'chip' + (v === s.auto.pool ? ' on' : ''), type: 'button', onclick: () => { buzz(); net.set('auto.pool', v); } }, label)));
    const favCount = Object.keys(s.favs).length;
    poolNote.textContent = s.auto.pool === 'fav' && !favCount ? 'No favourites yet: star some clips on the Clips tab.' : '';
    slots.forEach((b, i) => {
      const filled = !!s.scenes[i];
      b.classList.toggle('filled', filled);
      b.classList.toggle('armed', saveArmed);
      b.textContent = filled ? `${i + 1}` : '+';
    });
    saveBtn.textContent = saveArmed ? 'Now tap a slot… (tap here to cancel)' : 'Save the current look over a slot';
    saveBtn.classList.toggle('on', saveArmed);
    liveList.textContent = net.lives.length ? `Connected now: ${net.lives.map((l) => l.name).join(', ')}. Find them under "Live" on the Clips tab.` : 'No live input connected right now.';
  }
  return { el, update };
}
