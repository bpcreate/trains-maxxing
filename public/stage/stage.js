// The big screen. Mirrors the show state from the server and renders it.

import { Net } from '/lib/net.js';
import { LAYERS, beatAt, layerVisible } from '/shared/state.js';
import { Renderer } from './renderer.js';
import { LayerPlayer } from './layers.js';
import { LiveInputs } from './live.js';
import { Spray } from './spray.js';
import { BeatListener } from './audio.js';

const $ = (id) => document.getElementById(id);
const glCanvas = $('gl');
const panel = $('panel');

function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

let renderer;
try {
  renderer = new Renderer(glCanvas);
} catch (e) {
  $('fatal').style.display = 'flex';
  $('fatal').textContent = e.message;
  throw e;
}

const net = new Net('stage');
const lives = new LiveInputs(net);
const spray = new Spray($('spray'));
const players = {};
for (const id of LAYERS) players[id] = new LayerPlayer(id, { onNeed: (clipId) => net.send({ t: 'need', id: clipId }) });

// ---- help card with QR codes ----

let panelWanted = null; // null = automatic (shown until a phone connects)
function updatePanel() {
  const auto = net.peers.remotes === 0;
  panel.classList.toggle('hidden', !(panelWanted ?? auto));
  const n = net.peers.remotes;
  $('status').textContent = !net.connected ? 'Connecting…'
    : `${net.clips.length} clips · ${n} phone${n === 1 ? '' : 's'} connected` + (net.lives.length ? ` · ${net.lives.length} live input${net.lives.length === 1 ? '' : 's'}` : '');
}
net.on('status', () => {
  if (net.connected) {
    $('qr-remote').src = '/api/qr/remote.svg?' + Date.now();
    $('qr-kaleido').src = '/api/qr/kaleido.svg?' + Date.now();
  }
  updatePanel();
});
net.on('peers', () => {
  if (net.peers.remotes > 0 && panelWanted === true) panelWanted = null;
  updatePanel();
});
net.on('clips', updatePanel);

// ---- keys, fullscreen, cursor ----

function unlockAudio() {
  for (const p of Object.values(players)) p.audioOk = true;
  beat.ac?.resume?.();
}
function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
addEventListener('keydown', (e) => {
  unlockAudio();
  if (e.key === 'f' || e.key === 'F') fullscreen();
  else if (e.key === 'q' || e.key === 'Q') {
    panelWanted = panel.classList.contains('hidden');
    updatePanel();
  } else if (e.key === 'b' || e.key === 'B') net.act({ type: 'set', path: 'blackout', value: !net.state.blackout });
});
addEventListener('pointerdown', unlockAudio);
addEventListener('dblclick', fullscreen);
let idleTimer;
addEventListener('pointermove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
});
addEventListener('resize', () => {
  renderer.resize();
  spray.resize();
});

// ---- messages straight from phones ----

net.on('jog', (m) => players[m.l]?.jog(m));
net.on('spray', (m) => spray.stroke(m.s));
net.on('spray.clear', () => spray.clear());

const tagEl = $('tag');
function showTag({ text, color }) {
  if (!text) return;
  tagEl.textContent = text;
  tagEl.style.color = color;
  tagEl.style.fontSize = `${Math.max(5, Math.min(16, 110 / Math.max(6, text.length)))}vw`;
  tagEl.style.setProperty('--rot', `${(Math.random() * 14 - 7).toFixed(1)}deg`);
  tagEl.style.left = `${40 + Math.random() * 20}%`;
  tagEl.style.top = `${40 + Math.random() * 20}%`;
  tagEl.classList.remove('show');
  void tagEl.offsetWidth; // restart the animation
  tagEl.classList.add('show');
}
net.on('state', (a) => {
  if (a?.type === 'tag') showTag(net.state.tag);
});

// ---- microphone beat detection ----

const beat = new BeatListener(({ bpm, t0 }) => net.act({ type: 'tempo', bpm, t0: t0 + net.offset }));
let micBusy = false;
async function syncMic() {
  const want = net.state.tempo.mic;
  if (want && !beat.active && !micBusy) {
    micBusy = true;
    const ok = await beat.start();
    micBusy = false;
    if (!ok) {
      toast('Microphone is blocked on this laptop: allow it in the browser to use beat detection.', 6000);
      net.act({ type: 'set', path: 'tempo.mic', value: false });
    } else {
      toast('Listening to the music for the beat');
    }
  } else if (!want && beat.active) {
    beat.stop();
  }
}

// ---- render loop ----

const previewCanvas = document.createElement('canvas');
previewCanvas.width = 192;
previewCanvas.height = 108;
const pctx = previewCanvas.getContext('2d');
const thumbCanvas = document.createElement('canvas');
thumbCanvas.width = 96;
thumbCanvas.height = 54;
const tctx = thumbCanvas.getContext('2d');

let last = performance.now();
let lastPos = 0;
let lastPreview = 0;
let lastThumb = 0;
const t0 = performance.now();

function audible(s, id) {
  if (id === 'A') return 1 - s.xfade;
  if (id === 'B') return s.xfade;
  return s.layers[id].on ? s.layers[id].opacity : 0;
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (t - last) / 1000));
  last = t;
  const s = net.state;
  const beatNow = beatAt(s.tempo, net.now());

  LAYERS.forEach((id, i) => {
    const p = players[id];
    const ly = s.layers[id];
    p.sync(ly, net.clipsById, lives.videos);
    p.tick(dt, ly, { beat: beatNow, rewind: s.mom.rewind, audible: audible(s, id) });
    if (!p.el) renderer.setLayer(i, null);
    else if (!s.mom.freeze && layerVisible(s, id)) renderer.setLayer(i, p.el, renderer.fitFor(i, ly.fit) === 'fit');
  });

  renderer.render(s, { time: (t - t0) / 1000, beat: beatNow, dt });
  spray.tick(dt);
  $('spray').style.opacity = s.blackout ? 0 : 1;
  tagEl.style.visibility = s.blackout ? 'hidden' : 'visible';
  beat.tick();
  if (s.tempo.mic !== beat.active) syncMic();

  if (!net.connected) return;
  if (t - lastPos > 200) {
    lastPos = t;
    const p = {};
    for (const id of LAYERS) {
      const pl = players[id];
      p[id] = { p: Math.round(pl.progress * 1000) / 1000, d: Math.round(pl.duration * 10) / 10, ok: !!pl.el && pl.el.readyState >= 2 };
    }
    net.send({ t: 'pos', p });
  }
  if (net.peers.remotes > 0 && t - lastPreview > 500) {
    lastPreview = t;
    // must happen in the same frame as the render, before the buffer is cleared
    pctx.drawImage(glCanvas, 0, 0, 192, 108);
    if (!s.blackout && spray.dirty) pctx.drawImage($('spray'), 0, 0, 192, 108);
    net.send({ t: 'preview', img: previewCanvas.toDataURL('image/jpeg', 0.5) });
  }
  if (net.peers.remotes > 0 && lives.videos.size && t - lastThumb > 1000) {
    lastThumb = t;
    for (const [id, v] of lives.videos) {
      if (v.readyState < 2) continue;
      tctx.drawImage(v, 0, 0, 96, 54);
      net.send({ t: 'live.thumb', id, img: thumbCanvas.toDataURL('image/jpeg', 0.5) });
    }
  }
}
requestAnimationFrame(frame);

// hooks for the end-to-end test
window.__stage = {
  net, renderer, players, lives, spray,
  sample(x, y) {
    renderer.render(net.state, { time: (performance.now() - t0) / 1000, beat: beatAt(net.state.tempo, net.now()), dt: 0.016 });
    return renderer.readPixel(x, y);
  },
};
