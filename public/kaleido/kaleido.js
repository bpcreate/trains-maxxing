// Kaleidoscope: camera (or a photo / video) through a WebGL mirror shader,
// controlled by touch, streamed to the Trains Maxxing mixer as a live input.
// Works on its own too when no mixer is around.

import { Net } from '/lib/net.js';
import { h, slider, clamp, onLongPress } from '/remote/ui/dom.js';
import { beatAt, layerVisible, LAYERS } from '/shared/state.js';
import { Streamer } from './stream.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
canvas.width = 1280;
canvas.height = 720;

// ---------- picture parameters ----------

const MODES = [['wedge', 'Classic'], ['quad', 'Mirror ×4'], ['hex', 'Honeycomb'], ['tunnel', 'Tunnel'], ['off', 'Plain camera']];
const MODE_CODE = { off: 0, wedge: 1, quad: 2, hex: 3, tunnel: 4 }; // matches the shader
const DEFAULTS = { mode: 'wedge', seg: 8, spin: 0.15, twist: 0, zoom: 1, offX: 0, offY: 0, hue: 0, sat: 1.2, trails: 0, invert: false, beat: false };
const P = { ...DEFAULTS };
let rot = 0;
let frozen = false;

// ---------- WebGL ----------

const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSrc, uPrev;
uniform float uSrcAsp, uAsp, uMode, uSeg, uRot, uZoom, uTwist, uHue, uSat, uInvert, uTrails, uTime, uKick, uFlipX;
uniform vec2 uOff;
const float PI = 3.14159265;

vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
vec2 wedge(vec2 p, float n) {
  float seg = 2.0 * PI / n;
  float a = atan(p.y, p.x);
  a = abs(mod(a, seg) - seg * 0.5);
  return length(p) * vec2(cos(a), sin(a));
}
vec3 hueShift(vec3 c, float h) {
  const vec3 k = vec3(0.57735);
  float ca = cos(h * 2.0 * PI), sa = sin(h * 2.0 * PI);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAsp, 1.0);
  float fog = 1.0;
  p /= uZoom * (1.0 + 0.12 * uKick);
  if (uMode > 0.5) {
    p = rot2(p, uRot + uTwist * length(p) * 4.0);
    if (uMode < 1.5) {
      p = wedge(p, uSeg);
    } else if (uMode < 2.5) {
      p = abs(p);
    } else if (uMode < 3.5) {
      // honeycomb: nearest hexagon centre, then six mirrored wedges inside it
      p *= 1.0 + uSeg * 0.12;
      vec2 s = vec2(1.0, 1.7320508);
      vec2 a = mod(p, s) - s * 0.5;
      vec2 b = mod(p - s * 0.5, s) - s * 0.5;
      p = wedge(dot(a, a) < dot(b, b) ? a : b, 6.0) * 1.4;
    } else {
      float r = max(length(p), 0.02);
      float a = atan(p.y, p.x) / PI;
      // a whole number of mirrored repeats round the circle, so there is no seam
      p = vec2(a * floor(uSeg * 0.5 + 0.5), 0.25 / r + uTime * 0.15) - 0.5;
      fog = smoothstep(0.03, 0.3, r); // far end of the tunnel fades to dark
    }
  }
  // fit the source to cover the frame, then move the sampling point
  vec2 uv = p / vec2(uSrcAsp, 1.0) / max(uAsp / uSrcAsp, 1.0) + 0.5 + uOff;
  uv = 1.0 - abs(mod(uv, 2.0) - 1.0); // mirrored repeat: no hard edges
  if (uFlipX > 0.5) uv.x = 1.0 - uv.x;
  vec3 c = texture2D(uSrc, uv).rgb;
  if (uHue > 0.001) c = hueShift(c, uHue);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = clamp(mix(vec3(l), c, uSat), 0.0, 1.0);
  if (uInvert > 0.5) c = 1.0 - c;
  c *= fog;
  if (uTrails > 0.001) c = max(c, texture2D(uPrev, vUv).rgb * uTrails);
  gl_FragColor = vec4(c, 1.0);
}`;
const COPY = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

function makeProgram(frag) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}
function makeTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function makeTarget() {
  const tex = makeTex();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex };
}

const kal = makeProgram(FRAG);
const copy = makeProgram(COPY);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
const srcTex = makeTex();
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 0, 30, 255]));
const targets = [makeTarget(), makeTarget()];
let flip = 0;

// ---------- source: camera, photo or video ----------

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.loop = true;
let source = null;      // { el, w(), h(), still }
let facing = 'environment';
let camStream = null;
let stillDirty = false;

function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop());
  camStream = null;
}

async function useCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(location.protocol === 'https:' ? 'This browser has no camera access.' : 'The camera only works on the https:// address. Scan the kaleidoscope QR code again, or use a photo or video.');
  }
  stopCamera();
  camStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.srcObject = camStream;
  await video.play();
  source = { el: video, w: () => video.videoWidth, h: () => video.videoHeight, still: false, camera: true };
}

async function useFile(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    stopCamera();
    video.srcObject = null;
    video.src = url;
    await video.play();
    source = { el: video, w: () => video.videoWidth, h: () => video.videoHeight, still: false };
  } else {
    const img = new Image();
    img.src = url;
    await img.decode();
    stopCamera();
    video.pause();
    // very large photos are scaled down so they fit in a texture
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 2048);
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    source = { el: c, w: () => c.width, h: () => c.height, still: true };
    stillDirty = true;
  }
}

// ---------- mixer connection ----------

const net = new Net('kaleido');
const streamer = new Streamer(net, canvas);
let started = false; // true once a source is running; only then do we announce ourselves
const hello = () => net.connected && started && net.send({ t: 'live.hello', name: $('name').value, kind: 'kaleido' });
net.on('status', hello);

function updateStatus() {
  const el = $('status');
  const me = `live:${net.you}`;
  const onAir = net.connected && LAYERS.some((id) => net.state.layers[id].src === me && layerVisible(net.state, id)) && !net.state.blackout;
  el.classList.toggle('onair', onAir);
  el.classList.toggle('linked', net.connected && !onAir);
  $('status-text').textContent = onAir ? 'ON AIR' : !net.connected ? 'Not connected to the mixer'
    : !streamer.supported ? 'Connected, but this browser cannot stream'
    : streamer.live ? 'Streaming to the mixer' : net.peers.stages ? 'Connecting to the big screen…' : 'Waiting for the big screen';
}
net.on('state', updateStatus);
net.on('peers', updateStatus);
net.on('status', updateStatus);
setInterval(updateStatus, 1000);

// ---------- render loop ----------

let last = performance.now();
const t0 = last;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  rot += P.spin * dt * 1.6;

  if (source && !frozen) {
    const el = source.el;
    const ready = source.still ? stillDirty : el.readyState >= 2 && el.videoWidth > 0;
    if (ready) {
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
        stillDirty = false;
      } catch { /* frame not ready yet */ }
    }
  }

  const kick = P.beat && net.connected ? Math.exp(-((beatAt(net.state.tempo, net.now()) % 1 + 1) % 1) * 4) : 0;
  const out = targets[1 - flip];
  gl.bindFramebuffer(gl.FRAMEBUFFER, out.fb);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.useProgram(kal.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(kal.u.uSrc, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, targets[flip].tex);
  gl.uniform1i(kal.u.uPrev, 1);
  const sw = source ? source.w() : 16;
  const sh = source ? source.h() : 9;
  gl.uniform1f(kal.u.uSrcAsp, sw && sh ? sw / sh : 16 / 9);
  gl.uniform1f(kal.u.uAsp, canvas.width / canvas.height);
  gl.uniform1f(kal.u.uMode, MODE_CODE[P.mode]);
  gl.uniform1f(kal.u.uSeg, Math.round(P.seg));
  gl.uniform1f(kal.u.uRot, rot);
  gl.uniform1f(kal.u.uZoom, P.zoom);
  gl.uniform1f(kal.u.uTwist, P.twist);
  gl.uniform1f(kal.u.uHue, P.hue);
  gl.uniform1f(kal.u.uSat, P.sat);
  gl.uniform1f(kal.u.uInvert, P.invert ? 1 : 0);
  gl.uniform1f(kal.u.uTrails, P.trails > 0.01 ? 0.7 + P.trails * 0.29 : 0);
  gl.uniform1f(kal.u.uTime, ((t - t0) / 1000) % 3600);
  gl.uniform1f(kal.u.uKick, kick);
  gl.uniform1f(kal.u.uFlipX, source?.camera && facing === 'user' ? 1 : 0);
  gl.uniform2f(kal.u.uOff, P.offX, P.offY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  flip = 1 - flip;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(copy.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, out.tex);
  gl.uniform1i(copy.u.uTex, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
requestAnimationFrame(frame);

// ---------- touch: drag to move, pinch to zoom, twist to rotate ----------

const touches = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesture = null;
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  const prev = touches.get(e.pointerId);
  if (!prev) return;
  const size = canvas.getBoundingClientRect().height || 1;
  if (touches.size === 1) {
    P.offX = wrap(P.offX - ((e.clientX - prev.x) / size) * 0.6 / P.zoom);
    P.offY = wrap(P.offY + ((e.clientY - prev.y) / size) * 0.6 / P.zoom);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return;
  }
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const [a, b] = [...touches.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  if (gesture) {
    P.zoom = clamp(P.zoom * (dist / gesture.dist), 0.3, 6);
    let d = ang - gesture.ang;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    rot -= d;
    syncControls();
  }
  gesture = { dist, ang };
});
const lift = (e) => {
  touches.delete(e.pointerId);
  gesture = null;
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
const wrap = (v) => ((v + 1) % 2 + 2) % 2 - 1;

// ---------- controls ----------

const modeButtons = MODES.map(([id, label]) => h('button', { class: 'chip', type: 'button', onclick: () => { P.mode = id; syncControls(); } }, label));
$('modes').append(...modeButtons);

const sliders = {
  seg: slider({ min: 2, max: 24, value: P.seg, cls: '', label: 'Mirrors', onInput: (v) => { P.seg = Math.round(v / 2) * 2; syncControls(); } }),
  spin: slider({ min: -1, max: 1, value: P.spin, snaps: [0], label: 'Spin', onInput: (v) => { P.spin = v; } }),
  twist: slider({ min: -1, max: 1, value: P.twist, snaps: [0], label: 'Twist', onInput: (v) => { P.twist = v; } }),
  zoom: slider({ min: 0.3, max: 6, value: P.zoom, label: 'Zoom', onInput: (v) => { P.zoom = v; } }),
  hue: slider({ min: 0, max: 1, value: P.hue, label: 'Colour shift', onInput: (v) => { P.hue = v; } }),
  sat: slider({ min: 0, max: 2.5, value: P.sat, snaps: [1], label: 'Vivid', onInput: (v) => { P.sat = v; } }),
  trails: slider({ min: 0, max: 1, value: P.trails, label: 'Trails', onInput: (v) => { P.trails = v; } }),
};
$('sliders').append(...Object.values(sliders).map((s) => s.el));

function randomize() {
  const r = Math.random;
  Object.assign(P, {
    mode: ['wedge', 'wedge', 'quad', 'hex', 'tunnel'][Math.floor(r() * 5)],
    seg: 4 + Math.floor(r() * 9) * 2,
    spin: (r() - 0.5) * 0.8,
    twist: r() < 0.5 ? 0 : (r() - 0.5) * 0.8,
    zoom: 0.7 + r() * 1.8,
    offX: r() * 2 - 1,
    offY: r() * 2 - 1,
    hue: r() < 0.5 ? 0 : r(),
    sat: 1 + r() * 1.2,
    trails: r() < 0.6 ? 0 : r() * 0.8,
    invert: r() < 0.12,
  });
  syncControls();
}

const PRESET_KEY = 'tm-kaleido-presets';
const presets = (() => {
  try {
    return JSON.parse(localStorage.getItem(PRESET_KEY)) || [];
  } catch {
    return [];
  }
})();
const slotButtons = [0, 1, 2, 3].map((i) => {
  const b = h('button', { class: 'chip slot', type: 'button', 'aria-label': `Preset ${i + 1}: tap to recall, hold to save`, onclick: () => {
    if (presets[i]) Object.assign(P, DEFAULTS, presets[i]);
    else presets[i] = { ...P };
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    syncControls();
  } }, String(i + 1));
  onLongPress(b, () => {
    presets[i] = { ...P };
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    syncControls();
  });
  return b;
});

const btn = (label, fn) => h('button', { class: 'chip', type: 'button', onclick: fn }, label);
const flipBtn = btn('Flip camera', async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    await useCamera();
  } catch (e) {
    alert(e.message);
  }
  syncControls();
});
const fileBtn = btn('Photo / video', () => $('file').click());
const camBtn = btn('Camera', async () => {
  try {
    await useCamera();
  } catch (e) {
    alert(e.message);
  }
  syncControls();
});
const freezeBtn = btn('Freeze', () => { frozen = !frozen; syncControls(); });
const invertBtn = btn('Invert', () => { P.invert = !P.invert; syncControls(); });
const beatBtn = btn('Pulse to the beat', () => { P.beat = !P.beat; syncControls(); });
const randomBtn = btn('🎲 Surprise me', randomize);
const resetBtn = btn('Reset', () => { Object.assign(P, DEFAULTS); rot = 0; syncControls(); });
$('buttons').append(randomBtn, freezeBtn, invertBtn, beatBtn, flipBtn, camBtn, fileBtn, resetBtn, ...slotButtons);

function syncControls() {
  MODES.forEach(([id], i) => modeButtons[i].classList.toggle('on', P.mode === id));
  for (const [k, s] of Object.entries(sliders)) s.set(P[k]);
  sliders.seg.setLabel(`Mirrors: ${Math.round(P.seg)}`);
  sliders.seg.el.style.opacity = P.mode === 'quad' || P.mode === 'off' ? 0.4 : 1;
  freezeBtn.classList.toggle('on', frozen);
  invertBtn.classList.toggle('on', P.invert);
  beatBtn.classList.toggle('on', P.beat);
  flipBtn.hidden = !source?.camera;
  camBtn.hidden = !!source?.camera;
  slotButtons.forEach((b, i) => b.classList.toggle('filled', !!presets[i]));
}
syncControls();

$('menu-btn').addEventListener('click', () => {
  if (!started) return;
  $('controls').hidden = !$('controls').hidden;
});

// ---------- start screen ----------

$('name').value = localStorage.getItem('tm-kaleido-name') || 'Kaleidoscope';
function begin() {
  started = true;
  localStorage.setItem('tm-kaleido-name', $('name').value);
  $('start').hidden = true;
  $('controls').hidden = false;
  syncControls();
  hello();
  navigator.wakeLock?.request('screen').catch(() => {});
}
$('start-cam').addEventListener('click', async () => {
  $('start-error').textContent = '';
  try {
    await useCamera();
    begin();
  } catch (e) {
    $('start-error').textContent = e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this page in Safari settings, or use a photo or video.' : e.message;
  }
});
$('start-file').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (!file) return;
  try {
    await useFile(file);
    if (!started) begin();
    syncControls();
  } catch {
    $('start-error').textContent = 'That file could not be opened.';
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && started) navigator.wakeLock?.request('screen').catch(() => {});
});
document.addEventListener('gesturestart', (e) => e.preventDefault());

// hooks for the end-to-end test
window.__kaleido = {
  net, streamer, P, randomize,
  /** Stop all motion and square the pattern up. */
  still() {
    P.spin = 0;
    P.twist = 0;
    rot = 0;
    syncControls();
  },
};
