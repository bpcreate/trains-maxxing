// End-to-end test: starts the real server with synthetic clips, opens the
// stage, a phone-sized remote and the kaleidoscope in headless Chromium, and
// drives them like a person would.
//
//   npm run e2e
//
// Needs Playwright (with its Chromium) and ffmpeg. Chromium has no H.264
// decoder, so the test clips and proxies are WebM; H.264 proxy output is
// checked at the file level only.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Media, findFfmpeg, parseProbe } from '../server/media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'test/.tmp');
const MEDIA = path.join(TMP, 'media');
const DATA = path.join(TMP, 'data');
const SHOTS = path.join(TMP, 'shots');
const PORT = 8191;
const HTTPS_PORT = 8491;
const TOKEN = 'e2etoken42';
const BASE = `http://localhost:${PORT}`;

let playwright;
try {
  playwright = await import('playwright');
} catch {
  playwright = createRequire('/opt/node-tools/node_modules/')('playwright');
}
const { chromium, devices } = playwright;
const WebSocket = createRequire(import.meta.url)('ws');
const ffmpeg = findFfmpeg();
if (!ffmpeg) {
  console.error('ffmpeg not found');
  process.exit(2);
}

// ---------- results ----------

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const near = (px, rgb, tol = 60) => px.every((v, i) => Math.abs(v - rgb[i]) <= tol);

// ---------- fixtures ----------

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(MEDIA, 'yard'), { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
function clip(file, source, filter, extra) {
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source];
  if (filter) args.push('-vf', filter);
  args.push(...extra, path.join(MEDIA, file));
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${file}: ${r.stderr}`);
}
const VP8 = ['-c:v', 'libvpx', '-b:v', '1200k', '-g', '30', '-an'];
console.log('Generating test clips…');
// red with a yellow "train" crossing the middle band; corners stay red
clip('red-train.webm', 'color=c=red:size=1280x720:rate=30', "drawbox=x='mod(t*300,1280)':y=260:w=300:h=200:color=yellow:t=fill", ['-t', '6', ...VP8]);
// portrait: blue with a white box travelling down the middle
clip('yard/blue-portrait.webm', 'color=c=blue:size=720x1280:rate=30', "drawbox=x=160:y='mod(t*300,1280)':w=400:h=200:color=white:t=fill", ['-t', '5', ...VP8]);
clip('pattern.webm', 'testsrc2=size=1280x720:rate=30', null, ['-t', '8', ...VP8]);
// H.264 original: this Chromium cannot play it, so the stage must fall back to the proxy
clip('yard/green-h264.mp4', 'color=c=0x00ff00:size=1280x720:rate=30', null, ['-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);

// ---------- server ----------

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, TM_MEDIA: MEDIA, TM_DATA: DATA, TM_PROXY: 'webm', TM_PORT: String(PORT), TM_HTTPS_PORT: String(HTTPS_PORT), TM_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
await until(() => serverLog.includes('is running'), 'server start', 15000);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|MEDIA_ELEMENT_ERROR|DEMUXER_ERROR/.test(m.text())) pageErrors.push(`[${label}] ${m.text()}`);
  });
}

// software rendering is slow: keep the stage small
const stage = await browser.newPage({ viewport: { width: 640, height: 360 } });
watch(stage, 'stage');
const phone = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
const remote = await phone.newPage();
watch(remote, 'remote');

const sample = (x, y) => stage.evaluate(([x, y]) => window.__stage.sample(x, y), [x, y]);
const state = () => remote.evaluate(() => window.__remote.net.state);
const act = (a) => remote.evaluate((a) => window.__remote.net.act(a), a);
const tab = (name) => remote.click(`#tabs button:has-text("${name}")`);
const player = (id) => stage.evaluate((id) => {
  const p = window.__stage.players[id];
  return { pos: p.pos, dur: p.duration, dir: p.dir, key: p.curKey, url: p.curUrl, scrub: !!p.scrub, ready: !!p.el && p.el.readyState >= 2 };
}, id);
const clipId = (name) => remote.evaluate((n) => window.__remote.net.clips.find((c) => c.name === n)?.id, name);
async function drag(page, selector, dx, { steps = 8, hold = 0 } = {}) {
  const box = await page.locator(selector).first().boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x + (dx * i) / steps, y);
    await sleep(25);
  }
  if (hold) await sleep(hold);
  return { release: () => page.mouse.up(), box };
}

/** Put the mixer back to a known state so checks do not depend on each other. */
async function reset(tabName) {
  await remote.evaluate(() => {
    const { net } = window.__remote;
    const set = (path, value) => net.act({ type: 'set', path, value });
    for (const id of ['A', 'B', 'C', 'D']) {
      set(`layers.${id}.playing`, true);
      set(`layers.${id}.rate`, 1);
      set(`layers.${id}.mode`, 'loop');
      set(`layers.${id}.shuntBeats`, 0);
      set(`layers.${id}.in`, 0);
      set(`layers.${id}.out`, 1);
      set(`layers.${id}.fit`, 'auto');
    }
    for (const id of Object.keys(net.state.fx)) set(`fx.${id}.on`, false);
    for (const id of Object.keys(net.state.mom)) set(`mom.${id}`, false);
    set('auto.on', false);
    set('blackout', false);
    set('xfadeStyle', 'fade');
    set('abBlend', 'mix');
    set('xfade', 0);
    net.act({ type: 'eject', layer: 'C' });
    net.act({ type: 'eject', layer: 'D' });
  });
  if (tabName) await tab(tabName);
}
/** Load a clip on a deck and wait until the stage is really showing it. */
async function loadAndWait(layer, name, { proxy = false } = {}) {
  const id = await clipId(name);
  await act({ type: 'load', layer, src: id });
  await until(async () => {
    const p = await player(layer);
    return p.key === id && p.ready && (!proxy || p.url.includes('.proxy.'));
  }, `${name} playing on ${layer}`, 40000);
}

console.log('Running checks…');
try {
  await check('stage opens and shows the QR card until a phone connects', async () => {
    await stage.goto(`${BASE}/stage/`);
    await until(() => stage.evaluate(() => window.__stage?.net.connected), 'stage connected');
    assert(!(await stage.locator('#panel').evaluate((el) => el.classList.contains('hidden'))), 'QR card should be visible');
    const svg = await (await fetch(`${BASE}/api/qr/remote.svg`)).text();
    assert(svg.includes('<svg'), 'QR endpoint should return an SVG');
    await stage.screenshot({ path: path.join(SHOTS, 'stage-qr.png') });
  });

  await check('remote connects, lists clips with thumbnails, QR card hides', async () => {
    await remote.goto(`${BASE}/remote/`);
    await until(() => remote.evaluate(() => window.__remote?.net.connected), 'remote connected');
    await until(() => remote.evaluate(() => window.__remote.net.clips.length === 4 && window.__remote.net.clips.every((c) => c.ready && c.thumb && c.strip)), 'clips scanned');
    const clips = await remote.evaluate(() => window.__remote.net.clips);
    const portrait = clips.find((c) => c.name === 'blue-portrait');
    assert(portrait.portrait && portrait.crate === 'yard' && Math.abs(portrait.dur - 5) < 0.2, `portrait clip metadata wrong: ${JSON.stringify(portrait)}`);
    await until(() => stage.locator('#panel').evaluate((el) => el.classList.contains('hidden')), 'QR card hidden');
  });

  await check('tapping clips in the Clips tab loads decks A and B', async () => {
    await tab('Clips');
    await remote.click('.clip:has-text("red-train") .clip-main');
    await remote.click('.targets .chip:has-text("Deck B")');
    await remote.click('.clip:has-text("blue-portrait") .clip-main');
    const s = await state();
    assert(s.layers.A.src === (await clipId('red-train')) && s.layers.B.src === (await clipId('blue-portrait')), 'decks not loaded');
    await until(async () => (await player('A')).ready && (await player('B')).ready, 'both decks playing on stage');
    assert(near(await sample(0.05, 0.05), [255, 0, 0]), `deck A should show red, got ${await sample(0.05, 0.05)}`);
  });

  await check('dragging the crossfader swaps A for B; portrait gets a blurred backdrop', async () => {
    await reset('Mix');
    const d = await drag(remote, '.slider.xfader', 400);
    await d.release();
    assert((await state()).xfade === 1, `xfade should be 1, got ${(await state()).xfade}`);
    // portrait clip is pillar-boxed: blue in its right-hand strip, darker blur at the far left
    await until(async () => near(await sample(0.627, 0.5), [0, 0, 255]), 'stage shows blue');
    const side = await sample(0.03, 0.5);
    assert(side[2] > 40 && side[2] < 200 && side[0] < 60, `backdrop should be dim blue, got ${side}`);
    await remote.screenshot({ path: path.join(SHOTS, 'remote-mix.png') });
  });

  await check('tapping A glides the slider back', async () => {
    await remote.click('.xf-end.lA');
    await until(async () => (await state()).xfade === 0, 'glide to A', 5000);
    await until(async () => near(await sample(0.05, 0.05), [255, 0, 0]), 'stage shows red');
  });

  await check('blend modes, train wipe and split behave differently in the middle', async () => {
    await reset('Mix');
    await act({ type: 'set', path: 'layers.B.fit', value: 'fill' });
    await act({ type: 'set', path: 'xfade', value: 0.5 });
    await sleep(400);
    assert(near(await sample(0.05, 0.05), [128, 0, 128], 45), `mix should be purple, got ${await sample(0.05, 0.05)}`);
    await remote.click('.chips .chip:has-text("Add")');
    await sleep(400);
    assert(near(await sample(0.05, 0.05), [255, 0, 255], 45), `add should be magenta, got ${await sample(0.05, 0.05)}`);
    await remote.click('.chips .chip:has-text("Mix")');
    await remote.click('.chip:has-text("Train wipe")');
    await sleep(400);
    // B is sampled left of its travelling white box, so the colour is always blue
    assert(near(await sample(0.1, 0.05), [255, 0, 0]) && near(await sample(0.6, 0.05), [0, 0, 255]), `wipe should show A left, B right: ${await sample(0.1, 0.05)} | ${await sample(0.6, 0.05)}`);
    await remote.click('.chip:has-text("Split")');
    await sleep(400);
    assert(near(await sample(0.1, 0.05), [255, 0, 0]) && near(await sample(0.55, 0.05), [0, 0, 255]), `split should show A left, B right: ${await sample(0.1, 0.05)} | ${await sample(0.55, 0.05)}`);
    await remote.click('.chip:has-text("Fade")');
  });

  await check('loaded clips get a scrub-friendly proxy and the stage switches to it', async () => {
    await until(async () => (await player('A')).url?.includes('.proxy.'), 'deck A playing its proxy', 40000);
  });

  await check('an original the browser cannot play falls back to its proxy', async () => {
    await reset();
    await loadAndWait('D', 'green-h264', { proxy: true });
    await act({ type: 'set', path: 'layers.D.blend', value: 'mix' });
    await act({ type: 'set', path: 'layers.D.opacity', value: 1 });
    await until(async () => near(await sample(0.5, 0.5), [0, 255, 0], 70), 'stage shows green overlay');
  });

  await check('jog rail: dragging scratches the clip, releasing resumes play', async () => {
    await reset('Mix');
    await loadAndWait('A', 'pattern', { proxy: true });
    await act({ type: 'set', path: 'layers.A.playing', value: false });
    await sleep(600);
    // a tap jumps straight to that point: a quarter of the way along an 8 s clip is 2 s
    const rail = await remote.locator('.deck.lA .jog').boundingBox();
    await remote.mouse.click(rail.x + rail.width * 0.25, rail.y + rail.height / 2);
    await until(async () => Math.abs((await player('A')).pos - 2) < 0.2 && !(await player('A')).scrub, 'tap jumped to 2 s', 5000);
    await sleep(400); // let the position report reach the phone
    const before = await player('A');
    // full rail width = 8 s clip; a 150 px drag on a ~350 px rail is roughly 3.4 s
    const d = await drag(remote, '.deck.lA .jog', 150, { hold: 700 });
    const during = await player('A');
    assert(during.scrub, 'stage should be in scratch mode while the finger is down');
    assert(during.pos - before.pos > 2 && during.pos - before.pos < 5, `expected to move ~3.4 s forward, moved ${(during.pos - before.pos).toFixed(2)}`);
    await d.release();
    await sleep(500);
    const after = await player('A');
    assert(!after.scrub, 'scratch mode should end on release');
    const back = await drag(remote, '.deck.lA .jog', -100, { hold: 700 });
    const rew = await player('A');
    assert(rew.pos < after.pos - 1, `dragging left should go backwards: ${after.pos.toFixed(2)} -> ${rew.pos.toFixed(2)}`);
    await back.release();
  });

  await check('reverse plays backwards; shunt bounces between loop points', async () => {
    await reset('Mix');
    await loadAndWait('A', 'pattern', { proxy: true });
    await remote.click('.deck.lA .tbtn[aria-label="Reverse"]');
    assert((await state()).layers.A.rate === -1, 'rate should be -1');
    await sleep(500);
    const p1 = (await player('A')).pos;
    await sleep(1500);
    const p2 = (await player('A')).pos;
    // moved backwards (allowing for wrapping round the start)
    assert(p2 < p1 || p2 > p1 + 3, `expected backwards motion: ${p1.toFixed(2)} -> ${p2.toFixed(2)}`);
    await remote.click('.deck.lA .tbtn[aria-label="Reverse"]');
    await act({ type: 'set', path: 'layers.A.in', value: 0.4 });
    await act({ type: 'set', path: 'layers.A.out', value: 0.5 });
    await remote.click('.deck.lA .tbtn[aria-label="Shunt back and forth"]');
    const seen = new Set();
    const lo = 0.4 * 8 - 0.3;
    const hi = 0.5 * 8 + 0.3;
    await sleep(800);
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const p = await player('A');
      seen.add(p.dir);
      assert(p.pos > lo && p.pos < hi, `shunting left the loop: ${p.pos.toFixed(2)}`);
      await sleep(150);
    }
    assert(seen.size === 2, 'shunt should travel in both directions');
  });

  await check('Hold for GO cues clips; GO launches them together', async () => {
    await reset('Clips');
    await loadAndWait('A', 'red-train');
    await remote.click('.cue-toggle');
    await remote.click('.targets .chip:has-text("Overlay C")');
    await remote.click('.clip:has-text("pattern") .clip-main');
    await remote.click('.targets .chip:has-text("Deck A")');
    await remote.click('.clip:has-text("blue-portrait") .clip-main');
    let s = await state();
    assert(s.layers.C.cue && s.layers.A.cue && s.layers.A.src === (await clipId('red-train')) && !s.layers.C.src, 'clips should be cued, not playing');
    await remote.click('.cue-toggle');
    await tab('Mix');
    await sleep(1500); // let the stage preload
    assert((await remote.locator('.btn.go').first().textContent()).includes('2 waiting'), 'GO button should show two waiting');
    await remote.click('.btn.go >> nth=0');
    s = await state();
    assert(s.layers.A.src === (await clipId('blue-portrait')) && s.layers.C.src === (await clipId('pattern')) && s.layers.C.on, 'GO should load both');
    await until(async () => (await player('A')).key === (await clipId('blue-portrait')) && (await player('C')).key === (await clipId('pattern')), 'stage swapped both layers');
    const [a, c] = [await player('A'), await player('C')];
    assert(a.pos < 2.5 && c.pos < 2.5, `both should have just started: ${a.pos.toFixed(2)}, ${c.pos.toFixed(2)}`);
  });

  await check('every effect renders without errors and changes the picture', async () => {
    await reset('FX');
    // a detailed frame, paused, so any difference comes from the effect alone
    await loadAndWait('A', 'pattern', { proxy: true });
    await act({ type: 'set', path: 'layers.A.playing', value: false });
    await sleep(800);
    const ids = await remote.evaluate(() => Object.keys(window.__remote.net.state.fx));
    const grab = () => stage.evaluate(() => {
      const pts = [];
      for (let y = 0.1; y < 1; y += 0.2) for (let x = 0.1; x < 1; x += 0.2) pts.push(...window.__stage.sample(x, y));
      return { px: pts.join(','), err: window.__stage.renderer.gl.getError() };
    });
    const base = await grab();
    await sleep(300);
    assert((await grab()).px === base.px, 'paused frame should be perfectly still before testing effects');
    const still = [];
    for (const id of ids) {
      if (id === 'trails') continue; // needs motion: tested below
      await act({ type: 'set', path: `fx.${id}.on`, value: true });
      // sample a few moments: Beat Zoom only moves around the beat
      let changed = false;
      for (let i = 0; i < 6 && !changed; i++) {
        await sleep(200);
        const g = await grab();
        assert(g.err === 0, `GL error with effect ${id}`);
        changed = g.px !== base.px;
      }
      if (!changed) still.push(id);
      await act({ type: 'set', path: `fx.${id}.on`, value: false });
      await until(async () => (await grab()).px === base.px, `picture back to normal after ${id}`, 5000);
    }
    assert(still.length === 0, `these effects made no visible difference: ${still.join(', ')}`);
    // trails: the picture should linger after its source disappears
    await act({ type: 'set', path: 'fx.trails.amt', value: 1 });
    await act({ type: 'set', path: 'fx.trails.on', value: true });
    await sleep(500);
    await act({ type: 'eject', layer: 'A' });
    await sleep(700);
    const ghost = await grab();
    assert(ghost.err === 0, 'GL error with trails');
    assert(ghost.px.split(',').some((v) => +v > 40), 'with trails on, the picture should linger after the clip is removed');
    await act({ type: 'set', path: 'fx.trails.on', value: false });
    await until(async () => (await grab()).px.split(',').every((v) => +v < 8), 'screen clears once trails are off', 5000);
    await loadAndWait('A', 'red-train');
    await remote.click('.pad.fx:has-text("Kaleido")');
    assert((await state()).fx.kaleido.on && (await state()).fxSel === 'kaleido', 'tapping a pad should switch the effect on and select it');
    await sleep(500);
    await stage.screenshot({ path: path.join(SHOTS, 'stage-kaleido-fx.png') });
    await remote.screenshot({ path: path.join(SHOTS, 'remote-fx.png') });
    await remote.click('button:has-text("All effects off")');
    assert(Object.values((await state()).fx).every((f) => !f.on), 'all effects should be off');
  });

  await check('hold pads work only while pressed; blackout fades the screen out', async () => {
    await reset('FX');
    await loadAndWait('A', 'red-train');
    const box = await remote.locator('.pad.hold:has-text("Invert")').boundingBox();
    await remote.mouse.move(box.x + 20, box.y + 20);
    await remote.mouse.down();
    await until(async () => near(await sample(0.05, 0.05), [0, 255, 255]), 'inverted red is cyan');
    await remote.mouse.up();
    await until(async () => near(await sample(0.05, 0.05), [255, 0, 0]), 'back to red');
    assert(!(await state()).mom.invert, 'invert should be released');
    await remote.click('#black-btn');
    await until(async () => near(await sample(0.05, 0.05), [0, 0, 0], 12), 'screen black', 8000);
    await remote.click('#black-btn');
    await until(async () => near(await sample(0.05, 0.05), [255, 0, 0]), 'screen back');
  });

  await check('tap tempo sets the BPM', async () => {
    await reset('FX');
    await remote.locator('.btn.tap').scrollIntoViewIfNeeded();
    const box = await remote.locator('.btn.tap').boundingBox();
    for (let i = 0; i < 5; i++) {
      await remote.mouse.move(box.x + 10, box.y + 10);
      await remote.mouse.down();
      await remote.mouse.up();
      await sleep(400);
    }
    const bpm = await until(async () => {
      const b = (await state()).tempo.bpm;
      return b !== 120 ? b : null;
    }, 'tempo change', 4000);
    assert(bpm > 110 && bpm < 170, `tapping every ~0.4-0.5 s should give roughly 120-150 BPM, got ${bpm}`);
  });

  await check('scenes save and recall a look', async () => {
    await reset('Auto');
    await act({ type: 'set', path: 'xfade', value: 0.25 });
    await act({ type: 'set', path: 'fx.poster.on', value: true });
    await remote.click('.scene >> nth=0');
    assert((await state()).scenes[0], 'slot 1 should be filled');
    await act({ type: 'set', path: 'xfade', value: 1 });
    await act({ type: 'set', path: 'fx.poster.on', value: false });
    await remote.click('.scene >> nth=0');
    const s = await state();
    assert(s.xfade === 0.25 && s.fx.poster.on, 'recall should restore slider and effect');
  });

  await check('autopilot loads the other deck and crossfades to it by itself', async () => {
    await reset('Auto');
    await act({ type: 'tempo', bpm: 160, t0: Date.now() });
    await act({ type: 'set', path: 'auto.chaos', value: 0.9 });
    const before = (await state()).layers.B.seq;
    await remote.click('.auto-big');
    assert((await state()).auto.on, 'autopilot should be on');
    await until(async () => (await state()).layers.B.seq > before, 'autopilot loaded deck B', 15000);
    await until(async () => (await state()).xfade > 0.9, 'autopilot crossfaded to B', 15000);
    await remote.screenshot({ path: path.join(SHOTS, 'remote-auto.png') });
    await remote.click('#auto-btn');
    await sleep(300);
    const s = await state();
    assert(!s.auto.on, 'top-bar button should switch autopilot off');
    assert(Object.values(s.mom).every((v) => !v), 'no hold effect left on');
  });

  await check('spray paint and shout-outs reach the big screen', async () => {
    await reset('Tag');
    const d = await drag(remote, '.spray-pad', 120, { steps: 12 });
    await d.release();
    const painted = await until(() => stage.evaluate(() => {
      const c = document.getElementById('spray');
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 40) n++;
      return n;
    }), 'paint on the stage');
    assert(painted > 300, `expected a visible stroke, got ${painted} painted pixels`);
    await remote.fill('.tag-input', 'CHOO CHOO');
    await remote.click('button:has-text("Throw it up")');
    await until(() => stage.evaluate(() => document.getElementById('tag').textContent === 'CHOO CHOO' && document.getElementById('tag').classList.contains('show')), 'tag text on stage');
    await sleep(900);
    await stage.screenshot({ path: path.join(SHOTS, 'stage-tag.png') });
    await remote.screenshot({ path: path.join(SHOTS, 'remote-tag.png') });
    await remote.click('button:has-text("Wipe the wall")');
    await until(() => stage.evaluate(() => !window.__stage.spray.dirty), 'wall wiped');
  });

  await check('the phone gets a live preview of the output', async () => {
    const src = await until(() => remote.evaluate(() => document.getElementById('preview').src), 'preview image', 8000);
    assert(src.startsWith('data:image/jpeg'), 'preview should be a JPEG data URL');
  });

  await check('kaleidoscope: camera -> WebRTC -> stage, usable as a deck source', async () => {
    const pad = await browser.newContext({ viewport: { width: 1024, height: 768 }, ignoreHTTPSErrors: true, permissions: ['camera'], hasTouch: true });
    const kal = await pad.newPage();
    watch(kal, 'kaleido');
    await kal.goto(`https://localhost:${HTTPS_PORT}/kaleido/`);
    await kal.fill('#name', 'Test Pad');
    await kal.click('#start-cam');
    await until(() => remote.evaluate(() => window.__remote.net.lives.some((l) => l.name === 'Test Pad')), 'live input listed on the phone');
    // software WebRTC is slow to ramp up in this environment
    await until(() => stage.evaluate(() => [...window.__stage.lives.videos.values()].some((v) => v.readyState >= 2 && v.videoWidth > 0)), 'video arriving at the stage', 60000);
    await reset('Clips');
    await remote.click('.targets .chip:has-text("Deck A")');
    await until(() => remote.locator('.clip:has-text("Test Pad")').count(), 'live card in the Clips tab');
    await remote.click('.clip:has-text("Test Pad") .clip-main');
    await until(async () => {
      const px = [await sample(0.3, 0.3), await sample(0.5, 0.5), await sample(0.7, 0.6)];
      return px.some((p) => p[0] + p[1] + p[2] > 60);
    }, 'kaleidoscope picture on the stage', 20000);
    await until(async () => (await kal.textContent('#status-text')) === 'ON AIR', 'ON AIR light on the iPad');
    // gestures and controls change the parameters
    const before = await kal.evaluate(() => ({ ...window.__kaleido.P }));
    await kal.click('#modes .chip:has-text("Honeycomb")');
    const box = await kal.locator('#view').boundingBox();
    await kal.mouse.move(box.x + 300, box.y + 200);
    await kal.mouse.down();
    await kal.mouse.move(box.x + 420, box.y + 260, { steps: 5 });
    await kal.mouse.up();
    const after = await kal.evaluate(() => ({ ...window.__kaleido.P }));
    assert(after.mode === 'hex' && after.offX !== before.offX && after.offY !== before.offY, 'pattern chip and drag should change the picture');
    await sleep(800);
    await kal.screenshot({ path: path.join(SHOTS, 'kaleido.png') });
    await stage.screenshot({ path: path.join(SHOTS, 'stage-live.png') });
    await remote.screenshot({ path: path.join(SHOTS, 'remote-clips.png') });
    await pad.close();
    await until(() => remote.evaluate(() => window.__remote.net.lives.length === 0), 'live input removed when the iPad leaves');
  });

  await check('kaleidoscope works from a photo with no camera, and the picture is mirrored', async () => {
    const photo = path.join(TMP, 'photo.png');
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', photo]);
    const pad = await browser.newContext({ viewport: { width: 1024, height: 768 }, ignoreHTTPSErrors: true, hasTouch: true });
    const kal = await pad.newPage();
    watch(kal, 'kaleido-photo');
    await kal.goto(`https://localhost:${HTTPS_PORT}/kaleido/`);
    await kal.setInputFiles('#file', photo);
    await until(() => kal.locator('#start').isHidden(), 'start screen closes');
    await kal.click('button:has-text("Reset")');
    await kal.evaluate(() => window.__kaleido.still());
    await sleep(1200);
    // with no spin the classic pattern is symmetric top-to-bottom
    const diff = await kal.evaluate(() => {
      const src = document.getElementById('view');
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const g = c.getContext('2d');
      g.drawImage(src, 0, 0, 320, 180);
      const d = g.getImageData(0, 0, 320, 180).data;
      let total = 0, n = 0, variety = new Set();
      for (let y = 10; y < 80; y += 7) for (let x = 10; x < 310; x += 13) {
        const a = (y * 320 + x) * 4, b = ((179 - y) * 320 + x) * 4;
        total += Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]);
        variety.add(`${d[a] >> 5},${d[a + 1] >> 5},${d[a + 2] >> 5}`);
        n++;
      }
      return { avg: total / n, colours: variety.size };
    });
    assert(diff.colours >= 3, `picture should not be blank (found ${diff.colours} colours)`);
    assert(diff.avg < 30, `top and bottom halves should mirror each other (average difference ${diff.avg.toFixed(1)})`);

    // read the kaleidoscope picture at 320x180 and compare pairs of points that a pattern should make equal
    const pairs = (list) => kal.evaluate((list) => {
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = 180;
      const g = c.getContext('2d');
      g.drawImage(document.getElementById('view'), 0, 0, 320, 180);
      const d = g.getImageData(0, 0, 320, 180).data;
      const px = (x, y) => { const i = (Math.round(y) * 320 + Math.round(x)) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      let total = 0;
      const variety = new Set();
      for (const [x1, y1, x2, y2] of list) {
        const a = px(x1, y1), b = px(x2, y2);
        total += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        variety.add(a.map((v) => v >> 5).join());
      }
      return { avg: total / list.length, colours: variety.size };
    }, list);

    // circles: rings are 0.22 of the picture height wide (39.6 px here) and the picture mirrors across each ring edge
    await kal.click('#modes .chip:has-text("Circles")');
    await kal.evaluate(() => window.__kaleido.still());
    await sleep(900);
    const EDGE = 0.22 * 180;
    const ringPairs = [];
    for (let k = 0; k < 24; k++) {
      const ang = ((k + 0.37) / 24) * Math.PI * 2;
      for (const dist of [7, 14, 22, 30]) {
        ringPairs.push([160 + Math.cos(ang) * (EDGE - dist), 90 + Math.sin(ang) * (EDGE - dist), 160 + Math.cos(ang) * (EDGE + dist), 90 + Math.sin(ang) * (EDGE + dist)]);
      }
    }
    const rings = await pairs(ringPairs);
    assert(rings.colours >= 3, `circles picture should not be blank (found ${rings.colours} colours)`);
    assert(rings.avg < 30, `circles should mirror across the ring edge (average difference ${rings.avg.toFixed(1)})`);
    await kal.screenshot({ path: path.join(SHOTS, 'kaleido-circles.png') });

    // spiral with an even number of mirrors looks the same turned upside down
    await kal.click('#modes .chip:has-text("Spiral")');
    await kal.evaluate(() => window.__kaleido.still());
    await sleep(900);
    assert((await kal.textContent('#sliders .slider >> nth=0')).includes('Arms: 4'), 'slider should count arms in Spiral mode');
    const turnPairs = [];
    for (let y = 12; y < 85; y += 9) for (let x = 12; x < 310; x += 17) turnPairs.push([x, y, 319 - x, 179 - y]);
    const spiral = await pairs(turnPairs);
    assert(spiral.colours >= 3, `spiral picture should not be blank (found ${spiral.colours} colours)`);
    assert(spiral.avg < 30, `spiral should match itself turned half way round (average difference ${spiral.avg.toFixed(1)})`);
    // and it must differ from circles: same points, different picture
    assert((await pairs(ringPairs)).avg > rings.avg + 5, 'spiral should not look like circles');
    await kal.screenshot({ path: path.join(SHOTS, 'kaleido-spiral.png') });

    await kal.click('#modes .chip:has-text("Honeycomb")');
    await sleep(600);
    await kal.screenshot({ path: path.join(SHOTS, 'kaleido-photo.png') });
    await pad.close();
  });

  await check('controls need the session token from other devices', async () => {
    const ip = Object.values(os.networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
    if (!ip) {
      console.log('        (no LAN address in this environment: skipped)');
      return;
    }
    const open = (k) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://${ip}:${PORT}/ws?role=remote${k ? `&k=${k}` : ''}`);
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('error', () => resolve('refused'));
      ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`));
    });
    assert((await open('')) !== 'open', 'no token should be refused');
    assert((await open('wrong')) !== 'open', 'wrong token should be refused');
    assert((await open(TOKEN)) === 'open', 'right token should be accepted');
    assert((await fetch(`http://${ip}:${PORT}/api/info`)).status === 403, '/api/info should need the token');
  });

  await check('state is saved to disk', async () => {
    await act({ type: 'fav', id: await clipId('red-train') });
    await until(() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).favs).length === 1;
      } catch {
        return false;
      }
    }, 'state.json written', 5000);
  });

  await check('real-world proxy format: H.264 with a keyframe every 2 frames', async () => {
    const cache = path.join(TMP, 'h264-cache');
    const media = new Media({ mediaDir: MEDIA, cacheDir: cache, proxyFormat: 'mp4' });
    await fs.promises.mkdir(cache, { recursive: true });
    await media.scan();
    const c = await until(() => media.list().find((x) => x.name === 'blue-portrait' && x.ready), 'metadata');
    media.prep(c.id);
    await until(() => c.prep === 'ready' || c.prep === 'error', 'proxy encode', 60000);
    assert(c.prep === 'ready', 'proxy encode failed');
    const file = path.join(cache, `${c.id}.proxy.mp4`);
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
    const meta = parseProbe(probe);
    assert(/Video: h264/.test(probe) && meta.w === 720 && meta.h === 1280 && meta.fps === 30, `unexpected proxy: ${JSON.stringify(meta)}`);
    const frames = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-vf', 'showinfo', '-frames:v', '20', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const keys = (frames.match(/iskey:1/g) || []).length;
    assert(keys >= 9, `expected a keyframe every other frame, found ${keys} in 20 frames`);
  });

  await check('no page errors along the way', async () => {
    assert(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: ${path.relative(ROOT, SHOTS)}/`);
if (failed.length) {
  console.log('Server log tail:\n' + serverLog.split('\n').slice(-15).join('\n'));
  process.exit(1);
}
