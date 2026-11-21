// Phone remote: shell (top bar, tabs, crossfader, lock) around the five tabs.

import { Net } from '../lib/net.js';
import { h, slider, buzz } from './ui/dom.js';
import { mixView } from './ui/mix.js';
import { libraryView } from './ui/library.js';
import { fxView } from './ui/fx.js';
import { autoView } from './ui/auto.js';
import { tagView } from './ui/tag.js';

const net = new Net('remote');

const app = {
  net,
  pos: {},            // latest playhead positions from the stage
  liveThumbs: {},     // live id -> data url
  target: 'A',        // where the Clips tab sends clips
  returnToMix: false,
  toast,
  showTab,
  pickFor(id) {
    app.target = id;
    app.returnToMix = true;
    showTab('clips');
  },
};

// ---- toast ----
const toastEl = h('div', { id: 'toast', role: 'status' });
function toast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---- top bar ----
const preview = h('img', { id: 'preview', alt: 'What is on the big screen' });
const previewBtn = h('button', { id: 'preview-btn', type: 'button', 'aria-label': 'Enlarge preview', onclick: () => document.body.classList.toggle('big-preview') }, preview);
const autoBtn = h('button', { id: 'auto-btn', class: 'pill', type: 'button', onclick: () => { buzz(20); net.set('auto.on', !net.state.auto.on); } }, 'AUTO');
const blackBtn = h('button', { id: 'black-btn', class: 'pill', type: 'button', onclick: () => { buzz(20); net.set('blackout', !net.state.blackout); } }, 'BLACKOUT');
const lockBtn = h('button', { id: 'lock-btn', class: 'pill icon', type: 'button', 'aria-label': 'Lock the screen against pocket touches', onclick: () => lock(true) }, '🔒');
const banner = h('div', { id: 'banner' });
const top = h('header', { id: 'top' }, previewBtn, h('div', { class: 'brand' }, 'TRAINS', h('br'), 'MAXXING'), autoBtn, blackBtn, lockBtn);

// ---- lock screen ----
const lockFill = h('i');
const lockHold = h('button', { class: 'lock-hold', type: 'button' }, lockFill, h('span', {}, 'Hold to unlock'));
const lockScreen = h('div', { id: 'lock', hidden: true }, h('div', { class: 'lock-icon' }, '🔒'), h('p', {}, 'Locked so your pocket cannot mix.'), lockHold);
function lock(v) {
  lockScreen.hidden = !v;
  if (v) buzz(20);
}
let lockTimer = null;
lockHold.addEventListener('pointerdown', (e) => {
  lockHold.classList.add('holding');
  lockTimer = setTimeout(() => {
    lock(false);
    lockHold.classList.remove('holding');
    buzz(30);
  }, 900);
  e.preventDefault();
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  lockHold.addEventListener(ev, () => {
    clearTimeout(lockTimer);
    lockHold.classList.remove('holding');
  });
}

// ---- crossfader ----
let glide = null;
function glideTo(target) {
  buzz(15);
  clearInterval(glide);
  const from = net.state.xfade;
  const start = performance.now();
  const ms = 900;
  glide = setInterval(() => {
    const k = Math.min(1, (performance.now() - start) / ms);
    net.set('xfade', from + (target - from) * (k * k * (3 - 2 * k)));
    if (k >= 1) clearInterval(glide);
  }, 33);
}
const xf = slider({
  value: 0, relative: true, cls: 'xfader', snaps: [0.5], label: '',
  onInput: (v) => { clearInterval(glide); net.set('xfade', v); },
});
const xfA = h('button', { class: 'xf-end lA', type: 'button', 'aria-label': 'Glide to deck A', onclick: () => glideTo(0) }, 'A');
const xfB = h('button', { class: 'xf-end lB', type: 'button', 'aria-label': 'Glide to deck B', onclick: () => glideTo(1) }, 'B');
const xfRow = h('div', { id: 'xfade-row' }, xfA, xf.el, xfB);

// ---- tabs ----
const views = {
  mix: mixView(app),
  clips: libraryView(app),
  fx: fxView(app),
  auto: autoView(app),
  tag: tagView(app),
};
const TABS = [['mix', 'Mix', '🎚️'], ['clips', 'Clips', '🎞️'], ['fx', 'FX', '✨'], ['auto', 'Auto', '🤖'], ['tag', 'Tag', '🎨']];
const tabButtons = {};
const tabBar = h('nav', { id: 'tabs' }, TABS.map(([id, label, icon]) =>
  (tabButtons[id] = h('button', { type: 'button', onclick: () => { buzz(); app.returnToMix = false; showTab(id); } }, h('span', { class: 'tab-icon' }, icon), label))));
const main = h('main', { id: 'views' }, Object.values(views).map((v) => v.el));
let current = 'mix';
function showTab(id) {
  current = id;
  for (const [k, v] of Object.entries(views)) v.el.hidden = k !== id;
  for (const [k, b] of Object.entries(tabButtons)) b.classList.toggle('on', k === id);
  main.scrollTop = 0;
  update();
}

document.getElementById('app').append(top, banner, main, h('footer', {}, xfRow, tabBar), toastEl, lockScreen);

// ---- keeping everything in step ----
function update() {
  const s = net.state;
  autoBtn.classList.toggle('on', s.auto.on);
  blackBtn.classList.toggle('on', s.blackout);
  xf.set(s.xfade);
  xfA.classList.toggle('live', s.xfade < 0.5);
  xfB.classList.toggle('live', s.xfade >= 0.5);
  banner.textContent = !net.connected ? (net.everConnected ? 'Reconnecting to the laptop…' : 'Not connected yet. If this stays, scan the QR code on the big screen again.')
    : net.peers.stages === 0 ? 'The big screen is not open on the laptop yet.' : '';
  banner.hidden = !banner.textContent;
  views[current].update();
}
net.on('state', update);
net.on('clips', update);
net.on('peers', update);
net.on('status', update);
net.on('pos', (m) => {
  app.pos = m.p;
  if (current === 'mix') views.mix.updatePos();
});
net.on('preview', (m) => {
  preview.src = m.img;
  views.tag.setPreview(m.img);
});
net.on('live.thumb', (m) => {
  app.liveThumbs[m.id] = m.img;
  update();
});
showTab('mix');

// ---- keep the phone awake ----
let wake = null;
async function stayAwake() {
  if ('wakeLock' in navigator) {
    try {
      wake = await navigator.wakeLock.request('screen');
      return;
    } catch { /* fall through to the video trick */ }
  }
  // without HTTPS there is no Wake Lock API; a tiny looping video does the job
  if (!stayAwake.video) {
    const v = (stayAwake.video = h('video', { src: 'awake.mp4', loop: true, playsinline: true, style: { position: 'fixed', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' } }));
    v.volume = 0.001;
    document.body.append(v);
  }
  stayAwake.video.play().catch(() => {});
}
addEventListener('pointerdown', stayAwake, { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wake !== null) stayAwake();
});

// stop the page itself from bouncing or zooming under the controls
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

window.__remote = { net, app, showTab };
