// Kaleidoscope: camera (or a photo / video) through a WebGL mirror shader,
// controlled by touch, streamed to the Trains Maxxing mixer as a live input.
// Works on its own too when no mixer is around.

import { Net } from '/lib/net.js';
import { h, clamp, buzz, onLongPress } from '/remote/ui/dom.js';
import { beatAt, layerVisible, LAYERS } from '/shared/state.js';
import { Streamer } from './stream.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
canvas.width = 1280;
canvas.height = 720;

// ---------- picture parameters ----------

// left to right: plainest first, then mirrors, then the fractals
const MODES = [['off', 'Plain camera'], ['wedge', 'Classic'], ['hex', 'Honeycomb'], ['tunnel', 'Tunnel'], ['circles', 'Circles'], ['spiral', 'Spiral'],
  ['frames', 'Frames'], ['tri', 'Triangles'], ['carpet', 'Carpet'], ['koch', 'Snowflake'], ['bubbles', 'Bubbles'], ['julia', 'Julia'],
  ['void', 'Void'], ['voidmax', 'Void Maxxing'], ['quantum', 'Quantum Bubbles']];
const FRACTALS = ['tri', 'carpet', 'koch', 'bubbles', 'julia', 'voidmax', 'quantum']; // the slider sets how deep these go
const MODE_CODE = { off: 0, wedge: 1, hex: 3, tunnel: 4, circles: 5, spiral: 6, frames: 7, tri: 8, carpet: 9, koch: 10, bubbles: 11, julia: 12, void: 13, voidmax: 14, quantum: 15 }; // matches the shader
const DEFAULTS = { mode: 'wedge', seg: 8, spin: 0.15, twist: 0, zoom: 1, offX: 0, offY: 0, hue: 0, hueSpin: 0, dive: 0, sat: 1.2, satSpin: 0, trails: 0, invert: false, beat: false }; // hueSpin, satSpin: 0 off, 1 slow, 2 fast
const P = { ...DEFAULTS };
// Void Maxxing: each void holds three more, VOID_STEP times smaller, VOID_OUT of the way out from its centre (matches the shader)
const VOID_STEP = 2.380952, VOID_OUT = 0.5;
// Endless dive. Each of these patterns looks the same again after zooming by a fixed amount about one point:
// C is that point, L is the zoom (as a natural log) and the turn that go with one step, view is how much of the pattern fits on screen.
const DIVES = {
  frames: () => ({ C: [0, 0], L: [Math.log(1 + 8 / Math.round(P.seg)), 0], view: 1 }),
  tri: () => ({ C: [0, 1], L: [Math.log(2), 0], view: 1.4 }),             // a corner, where six mirrored triangles meet
  carpet: () => ({ C: [1, 1], L: [Math.log(3), 0], view: 1.9 }),          // a corner, where four mirrored carpets meet
  // a tip of the snowflake. `extra` levels of folding while diving, so the level that fades in is too fine to see arrive.
  koch: () => ({ C: [0.5, 0.2886751], L: [Math.log(3), 0], view: 0.45, extra: 3 }),
  // a point the fold-and-flip lands back on; two rounds of it magnify 15.19 times. Every round reshapes the whole
  // picture here, so this one does not repeat exactly: each loop dissolves into the next.
  bubbles: () => ({ C: [0.408392, 0.408392], L: [Math.log(15.1873), 0], view: 0.5 }),
  // a point the Julia step leaves where it is; one step magnifies and turns the view round it. Julia bends the picture,
  // so it only repeats exactly very close to that point: the view starts `ahead` steps further in, and `extra` rounds
  // of the pattern bring it back out to size.
  julia: () => {
    const cx = 0.7885 * Math.cos(rot), cy = 0.7885 * Math.sin(rot);
    const ax = 1 - 4 * cx, ay = -4 * cy, m = Math.hypot(ax, ay);
    const wx = Math.sqrt((m + ax) / 2), wy = Math.sign(ay || 1) * Math.sqrt((m - ax) / 2); // square root of 1 - 4c
    return { C: [(1 + wx) / 2, wy / 2], L: [Math.log(Math.hypot(1 + wx, wy)), Math.atan2(wy, 1 + wx)], view: 1, ahead: 3, extra: 3 };
  },
  // the hole stays put while the picture round it shrinks into it; a plain picture never repeats, so each loop dissolves into the next
  void: () => ({ C: [0, 0], L: [Math.log(2), 0], view: 1 }),
  // the point that sits inside a void inside a void, for ever: falling towards it passes one rim after another
  voidmax: () => ({ C: [VOID_STEP * VOID_OUT / (VOID_STEP - 1), 0], L: [Math.log(VOID_STEP), 0], view: 0.9 / VOID_STEP ** 2, extra: 4 }),
  // every size of bubble is the same foam drawn at half the size
  quantum: () => ({ C: [0.37, 0.21], L: [Math.log(2), 0], view: 2, extra: 1 }),
};
let rot = 0;
let divePhase = 0; // how far through one loop of the endless dive, 0..1
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
uniform float uSrcAsp, uAsp, uMode, uSeg, uRot, uZoom, uTwist, uHue, uSat, uInvert, uTrails, uTime, uKick, uFlipX, uDive, uDiveOn, uDiveV, uDiveT0, uDiveX;
uniform vec2 uOff, uDiveC, uDiveL;
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
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
float hash1(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 v) { return fract(sin(vec2(dot(v, vec2(269.5, 183.3)), dot(v, vec2(113.5, 271.9)))) * 43758.5453); }

// Which point of the source picture a point of the screen shows.
// dz and zmag place the view for the endless dive (see main); they are 1 when not diving.
vec2 warp(vec2 p, vec2 dz, float zmag, out float fog) {
  fog = 1.0;
  bool dive = uDiveOn > 0.5;
  if (uMode > 0.5) {
    // julia uses the rotation to change its shape instead of turning the picture
    p = rot2(p, (uMode > 11.5 && uMode < 12.5 ? 0.0 : uRot) + uTwist * length(p) * 4.0);
    float depth = clamp(uSeg * 0.5, 1.0, 12.0); // how many times the fractal patterns repeat inside themselves
    if (uMode < 1.5) {
      // each fold of the angle makes two wedges, so the count on the slider is the number of wedges on screen
      p = wedge(p, uSeg * 0.5);
    } else if (uMode < 3.5) {
      // honeycomb: nearest hexagon centre, then six mirrored wedges inside it
      p *= 1.0 + uSeg * 0.12;
      vec2 s = vec2(1.0, 1.7320508);
      vec2 a = mod(p, s) - s * 0.5;
      vec2 b = mod(p - s * 0.5, s) - s * 0.5;
      p = wedge(dot(a, a) < dot(b, b) ? a : b, 6.0) * 1.4;
    } else if (uMode < 4.5) {
      float r = max(length(p), 0.02);
      float a = atan(p.y, p.x) / PI;
      // a whole number of mirrored repeats round the circle, so there is no seam
      p = vec2(a * floor(uSeg * 0.5 + 0.5), 0.25 / r + uTime * 0.15) - 0.5;
      fog = smoothstep(0.03, 0.3, r); // far end of the tunnel fades to dark
    } else if (uMode < 5.5) {
      // circles: classic mirrors, then mirrored again ring after ring outwards.
      // Rings have a fixed size here, so zooming changes how many fit on screen.
      const float w = 0.22;
      p = wedge(p, uSeg * 0.5);
      float r = length(p);
      float t = abs(mod(r, 2.0 * w) - w);
      p = (r > 1e-5 ? p / r : vec2(1.0, 0.0)) * (w - t) * (0.45 / w);
    } else if (uMode < 6.5) {
      // spiral: mirrored arms on a double spiral that repeats smaller and smaller inwards
      float r = max(length(p), 1e-4);
      float lr = log(r);
      float th = atan(p.y, p.x);
      float seg = 2.0 * PI / uSeg;
      float a = abs(mod(th + lr * 1.5, seg) - seg * 0.5);
      // bands follow the spiral; one full turn shifts by two whole bands, so there is no seam
      float t = abs(mod(lr - th / PI, 1.0) - 0.5);
      p = 0.12 * exp(t * 2.64) * vec2(cos(a), sin(a));
      fog = smoothstep(0.0, 0.07, r); // the centre gets too fine to draw: fade it out
    } else if (uMode < 7.5) {
      // frames: the picture inside itself, smaller each time. More on the slider packs the frames closer.
      p = cmul(p, dz);
      float s = 1.0 + 8.0 / uSeg;
      vec2 q = abs(p) / vec2(uAsp, 1.0) * 2.0; // 1.0 at the edge of the screen
      float m = max(max(q.x, q.y), 1e-4);
      p *= pow(s, -ceil(log(m) / log(s)));
      fog = smoothstep(0.004, 0.03, m * zmag);
    } else if (uMode < 8.5) {
      // triangles (Sierpinski): fold onto one corner and double, until the point lands in a hole.
      // Big holes stop early and show a big picture, small holes a small one.
      const vec2 nS = vec2(-0.5, 0.8660254); // mirror between the top corner and a bottom one
      const vec2 nE = vec2(0.8660254, 0.5);  // a side of the triangle
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * 2.3 + vec2(0.0, 0.25);
      // the triangle is mirrored across its sides to cover the whole screen
      for (int i = 0; i < 4; i++) {
        p.x = abs(p.x);
        p -= 2.0 * min(0.0, dot(p, nS)) * nS;
        p.x = abs(p.x);
        p -= 2.0 * max(0.0, dot(p, nE) - 0.5) * nE;
      }
      for (int i = 0; i < 12; i++) {
        if (float(i) >= depth) break;
        p.x = abs(p.x);
        p -= 2.0 * min(0.0, dot(p, nS)) * nS;
        p.x = abs(p.x); // so every mirror image of a point ends up in exactly the same place
        if (dot(p, nE) > 0.5) break;
        p = 2.0 * p - vec2(0.0, 1.0);
      }
      p *= 0.5;
    } else if (uMode < 9.5) {
      // carpet (Sierpinski): a square cut into nine, the middle one a window, the other eight cut again
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * 2.1;
      p = abs(mod(p + 1.0, 4.0) - 2.0) - 1.0; // the square is mirrored to cover the whole screen
      for (int i = 0; i < 12; i++) {
        if (float(i) >= depth) break;
        p = abs(p);
        if (max(p.x, p.y) < 1.0 / 3.0) { p *= 3.0; break; }
        p = 3.0 * (p - step(1.0 / 3.0, p) * (2.0 / 3.0));
      }
      p *= 0.5;
    } else if (uMode < 10.5) {
      // snowflake (Koch): mirrors laid along the snowflake curve. The picture keeps its size; only the folds get finer.
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * 1.25;
      p.x = abs(p.x);
      p.y += tan(5.0 / 6.0 * PI) * 0.5;
      vec2 n = vec2(sin(5.0 / 6.0 * PI), cos(5.0 / 6.0 * PI));
      p -= n * max(0.0, dot(p - vec2(0.5, 0.0), n)) * 2.0;
      n = vec2(sin(2.0 / 3.0 * PI), cos(2.0 / 3.0 * PI));
      float scale = 1.0;
      p.x += 0.5;
      for (int i = 0; i < 10; i++) {
        if (float(i) >= min(depth, 7.0) + uDiveX) break;
        p *= 3.0;
        scale *= 3.0;
        p.x -= 1.5;
        p.x = abs(p.x);
        p.x -= 0.5;
        p -= n * min(0.0, dot(p, n)) * 2.0;
      }
      // measured from the tip of the curve at (1, 0), which every level of folding leaves alone, so adding a level
      // only adds folds and never slides the picture. zmag: the picture stays the same size while the folds dive past.
      p = (p - vec2(1.0, 0.0)) / scale * 4.0 * zmag;
    } else if (uMode < 11.5) {
      // bubbles (Apollonian): fold into a square, turn it inside out through a circle, and again
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * 2.0;
      float sc = 1.0;
      for (int i = 0; i < 8; i++) {
        if (float(i) >= depth) break;
        p = abs(mod(p + 1.0, 4.0) - 2.0) - 1.0;
        float k = 1.3 / max(dot(p, p), 0.02);
        p *= k;
        sc *= k;
      }
      p = (abs(mod(p + 1.0, 4.0) - 2.0) - 1.0) * 0.5;
      fog = 1.0 - smoothstep(40.0, 400.0, sc / zmag); // where it gets too fine to draw, fade to dark
    } else if (uMode < 12.5) {
      // julia: square the point and add a constant, over and over. The rotation picks the constant, so spinning reshapes it.
      vec2 c = 0.7885 * vec2(cos(uRot), sin(uRot));
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * 2.6;
      for (int i = 0; i < 16; i++) {
        if (float(i) > depth + uDiveX) break;
        p = vec2(p.x * p.x - p.y * p.y, 2.0 * p.x * p.y) + c;
        if (dot(p, p) > 16.0) break;
      }
      p *= 0.25;
    } else if (uMode < 13.5) {
      // void: a black hole in the middle of the picture. The picture bends round it the way light does:
      // the middle of the picture is smeared into a ring, and just outside the hole it shows again, flipped.
      float hole = (0.06 + 0.03 * depth) * (1.0 + 0.2 * uKick);
      float r = max(length(p), 1e-4);
      float ring = hole * 1.5;
      fog = smoothstep(hole, hole * 1.05, r) * (1.0 + 1.6 * exp(-(r - hole) / (hole * 0.12))); // black inside, a glowing edge
      p *= (1.0 - ring * ring / (r * r)) * zmag; // diving shrinks the picture into the hole
    } else if (uMode < 14.5) {
      // void maxxing: one void fills the screen and only a thin rim of picture is left. Inside it sit three more
      // voids, each with its own rim and three more inside, and so on down.
      const float STEP = 2.380952; // how many times smaller each void is than the one it sits in
      const float OUT = 0.5;       // how far out from the centre the three sit
      const float RIM = 0.08;
      float view = dive ? uDiveV / zmag : 2.15;
      p = dive ? uDiveC + cmul(p * uDiveV, dz) : p * view;
      float sc = 1.0;
      vec2 q = vec2(0.0);
      fog = 0.0;
      for (int i = 0; i < 18; i++) {
        if (float(i) >= depth + uDiveX) break;
        float r = length(p);
        if (r > 1.0) break;
        if (r > 1.0 - RIM) {
          // the whole picture squeezed into the rim, its middle on the outer edge
          float f = (r - 1.0 + RIM) / RIM;
          q = p / r * (1.0 - f) * 0.5;
          fog = smoothstep(0.0, 0.2, f) * smoothstep(1.0, 0.8, f) * 1.5;
          // a rim thinner than a dot on the screen fades out instead of sparkling
          fog *= smoothstep(0.5, 1.5, RIM * 720.0 * uZoom / (sc * view));
          break;
        }
        // three ways round the centre look the same: fold them onto one and step into the void there
        float a = atan(p.y, p.x);
        a = abs(mod(a + PI / 3.0, 2.0 * PI / 3.0) - PI / 3.0);
        p = (r * vec2(cos(a), sin(a)) - vec2(OUT, 0.0)) * STEP;
        sc *= STEP;
      }
      p = q;
    } else {
      // quantum bubbles: foam. Bubbles of every size pop into being, swell and vanish, never in the same place twice.
      // Each one is a glass ball with the whole picture inside it; the picture itself is only just visible behind.
      vec2 w = dive ? uDiveC + cmul(p * uDiveV, dz) : p;
      fog = 0.08;
      float sc = 2.0; // the biggest bubbles sit in squares half the screen high; each layer after is half the size
      for (int i = 0; i < 8; i++) {
        if (float(i) >= min(depth, 6.0) + uDiveX) break;
        vec2 g = w * sc;
        vec2 id = floor(g);
        float h = hash1(id);
        float life = uTime * (0.15 + 0.35 * h) + h * 17.0; // each square runs at its own pace
        float born = floor(life);
        float age = life - born;
        vec2 k = hash2(id + born * 7.13); // a new place and size every time one appears
        vec2 c = (k - 0.5) * 0.4 + 0.012 * sin(uTime * (17.0 + 9.0 * k.yx) + h * 40.0); // it trembles on the spot
        float rad = (0.10 + 0.15 * hash1(id * 1.7 + born)) * sqrt(sin(PI * age)) * (1.0 + 0.15 * uKick);
        vec2 d = g - id - 0.5 - c;
        float r = length(d);
        if (r < rad) {
          vec2 q = d / rad;
          float m = dot(q, q);
          p = rot2(q, h * 2.0 * PI) * (0.3 + 0.45 * m); // squeezed towards the edge, like a glass ball; turned its own way
          fog = (0.8 + 1.1 * m * m) * smoothstep(1.0, 0.93, sqrt(m)); // brighter round the edge
          break;
        }
        sc *= 2.0;
      }
    }
  }
  return p;
}
// colour of the source seen from a point of the screen; alpha carries the fade to dark
vec4 look(vec2 p, float t) {
  float fog;
  t += uDiveT0;
  float ang = -t * uDiveL.y;
  p = warp(p, exp(-t * uDiveL.x) * vec2(cos(ang), sin(ang)), exp(t * uDiveL.x), fog);
  // fit the source to cover the frame, then move the sampling point
  vec2 uv = p / vec2(uSrcAsp, 1.0) / max(uAsp / uSrcAsp, 1.0) + 0.5 + uOff;
  uv = 1.0 - abs(mod(uv, 2.0) - 1.0); // mirrored repeat: no hard edges
  if (uFlipX > 0.5) uv.x = 1.0 - uv.x;
  return vec4(texture2D(uSrc, uv).rgb, fog);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAsp, 1.0);
  p /= uZoom * (1.0 + 0.12 * uKick);
  // Endless dive: each fractal looks the same again after zooming by a fixed amount about the right point,
  // so the zoom runs from 1 up to that amount and starts over. Two views one step apart are blended,
  // which hides the restart and lets the finest level of detail fade in instead of popping.
  vec4 seen = uDiveOn > 0.5 ? mix(look(p, uDive + 1.0), look(p, uDive), smoothstep(0.2, 0.8, uDive)) : look(p, 0.0);
  vec3 c = seen.rgb;
  float fog = seen.a;
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
  const dive = P.dive ? DIVES[P.mode]?.() : null;
  if (dive) divePhase = (((divePhase + (P.dive * dt * 0.9) / dive.L[0]) % 1) + 1) % 1; // same speed on screen whatever the pattern's step
  if (P.hueSpin && !hueRail.held) {
    P.hue = (P.hue + dt * HUE_TURN[P.hueSpin]) % 1;
    paintHue();
  }
  if (P.satSpin && !satRail.held) {
    satPhase += dt * 2 * Math.PI * SAT_SWING[P.satSpin];
    P.sat = satFromPhase();
    satRail.paint();
  }

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
  gl.uniform1f(kal.u.uDiveOn, dive ? 1 : 0);
  gl.uniform1f(kal.u.uDive, dive ? divePhase : 0);
  gl.uniform1f(kal.u.uDiveV, dive ? dive.view : 1);
  gl.uniform1f(kal.u.uDiveT0, dive?.ahead || 0);
  gl.uniform1f(kal.u.uDiveX, dive?.extra || 0);
  gl.uniform2f(kal.u.uDiveC, ...(dive ? dive.C : [0, 0]));
  gl.uniform2f(kal.u.uDiveL, ...(dive ? dive.L : [0, 0]));
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

// Pattern tiles: each one is a line drawing of the mirrors that pattern makes.
const f1 = (n) => n.toFixed(1);
const spokes = (n, turn = 0) => Array.from({ length: n }, (_, i) => {
  const a = turn + (i / n) * 2 * Math.PI;
  return `<path d="M20 20L${f1(20 + 30 * Math.cos(a))} ${f1(20 + 30 * Math.sin(a))}"/>`;
}).join('');
const rings = (...radii) => radii.map((r) => `<circle cx="20" cy="20" r="${r}"/>`).join('');
function honeycomb() {
  const d = 12, R = d / Math.sqrt(3);
  let out = '';
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const cx = 20 + i * d + (j & 1 ? d / 2 : 0), cy = 20 + j * R * 1.5;
    out += `<polygon points="${[0, 1, 2, 3, 4, 5].map((k) => `${f1(cx + R * Math.sin(k * Math.PI / 3))},${f1(cy + R * Math.cos(k * Math.PI / 3))}`).join(' ')}"/>`;
  }
  return out;
}
function spiralArms(n) {
  let out = '';
  for (let arm = 0; arm < n; arm++) {
    const pts = [];
    for (let th = 0; th <= 14; th += 0.25) {
      const r = 1.5 * Math.exp(0.22 * th), a = th + (arm / n) * 2 * Math.PI;
      pts.push(`${f1(20 + r * Math.cos(a))},${f1(20 + r * Math.sin(a))}`);
    }
    out += `<polyline points="${pts.join(' ')}"/>`;
  }
  return out;
}
function triangleHoles(a, b, c, depth) {
  const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
  const hole = `<polygon points="${[ab, bc, ca].map((q) => `${f1(q[0])},${f1(q[1])}`).join(' ')}"/>`;
  return depth <= 1 ? hole : hole + triangleHoles(a, ab, ca, depth - 1) + triangleHoles(ab, b, bc, depth - 1) + triangleHoles(ca, bc, c, depth - 1);
}
function carpetHoles(x, y, size, depth) {
  const t = size / 3;
  let out = `<rect x="${f1(x + t)}" y="${f1(y + t)}" width="${f1(t)}" height="${f1(t)}"/>`;
  if (depth > 1) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if (i !== 1 || j !== 1) out += carpetHoles(x + i * t, y + j * t, t, depth - 1);
  return out;
}
function snowflake(depth) {
  let pts = [0, 1, 2].map((k) => [20 + 16 * Math.sin(k * 2 * Math.PI / 3), 20 - 16 * Math.cos(k * 2 * Math.PI / 3)]);
  for (let d = 0; d < depth; d++) {
    const next = [];
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const dx = (b[0] - a[0]) / 3, dy = (b[1] - a[1]) / 3;
      // each edge grows a point on its outer side
      next.push(a, [a[0] + dx, a[1] + dy], [a[0] + 1.5 * dx + 0.866 * dy, a[1] + 1.5 * dy - 0.866 * dx], [a[0] + 2 * dx, a[1] + 2 * dy]);
    });
    pts = next;
  }
  return `<polygon points="${pts.map((q) => `${f1(q[0])},${f1(q[1])}`).join(' ')}"/>`;
}
function bubbles() {
  const at = (deg, dist, r) => `<circle cx="${f1(20 + dist * Math.cos(deg * Math.PI / 180))}" cy="${f1(20 - dist * Math.sin(deg * Math.PI / 180))}" r="${r}"/>`;
  // three circles that touch each other and the rim, with smaller ones in the gaps
  return rings(17, 1.2) + [90, 210, 330].map((a) => at(a, 9.1, 7.9)).join('') + [30, 150, 270].map((a) => at(a, 13.2, 3.8)).join('');
}
function juliaBlob() {
  // the filled-in Julia set for one constant, drawn as small blocks
  let d = '';
  for (let y = 3; y < 37; y += 1) for (let x = 3; x < 37; x += 1) {
    let zx = (x + 0.5 - 20) / 10.5, zy = (y + 0.5 - 20) / 10.5, n = 0;
    while (n < 24 && zx * zx + zy * zy < 4) { [zx, zy] = [zx * zx - zy * zy - 0.77, 2 * zx * zy + 0.12]; n++; }
    if (n === 24) d += `M${x} ${y}h1v1h-1z`;
  }
  return `<path d="${d}" fill="currentColor" stroke="none"/>`;
}
function voidNest(cx, cy, r, depth) {
  let out = `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}"/>`;
  if (depth > 1) for (const a of [0, 120, 240]) out += voidNest(cx + r * VOID_OUT * Math.cos(a * Math.PI / 180), cy - r * VOID_OUT * Math.sin(a * Math.PI / 180), r / VOID_STEP, depth - 1);
  return out;
}
function foam() {
  // bubbles of all sizes; the dotted ones are on their way in or out
  const b = [[13, 14, 8.5], [28, 11, 5], [27.5, 27, 7, 1], [11.5, 30, 4], [20, 21, 2.2, 1], [34, 19, 2.5], [6, 22, 1.8, 1], [19, 6, 2], [18.5, 34, 1.6]];
  return b.map(([x, y, r, faint]) => `<circle cx="${x}" cy="${y}" r="${r}"${faint ? ' stroke-dasharray="1.6 1.6"' : ''}/>`).join('');
}
const MODE_ART = {
  void: '<circle cx="20" cy="20" r="7.5" fill="currentColor"/>' + rings(10.5, 14, 19, 26),
  voidmax: voidNest(20, 20, 17, 3),
  quantum: foam(),
  frames: '<rect x="6.5" y="6.5" width="27" height="27"/><rect x="11.5" y="11.5" width="17" height="17"/><rect x="15.5" y="15.5" width="9" height="9"/><rect x="18" y="18" width="4" height="4"/>',
  tri: '<polygon points="20,5 37,34.5 3,34.5"/>' + triangleHoles([20, 5], [37, 34.5], [3, 34.5], 3),
  carpet: carpetHoles(4, 4, 32, 2),
  koch: snowflake(2),
  bubbles: bubbles(),
  julia: juliaBlob(),
  wedge: spokes(8),
  hex: honeycomb(),
  tunnel: spokes(8, Math.PI / 8) + rings(2.5, 5.5, 10, 17) + '<circle cx="20" cy="20" r="1.2" fill="currentColor"/>',
  circles: rings(4.5, 9, 13.5, 18, 22.5, 27),
  spiral: spiralArms(3),
  off: '<circle cx="13" cy="13" r="3.2"/><path d="M2 33L14 20L22 28L28 22L38 33"/>',
};
function modeIcon(id) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><clipPath id="tile-${id}"><rect x="2" y="2" width="36" height="36" rx="3"/></clipPath>`
    + `<g clip-path="url(#tile-${id})">${MODE_ART[id]}</g><rect x="2" y="2" width="36" height="36" rx="3"/></svg>`;
  return span.firstChild;
}
const modeButtons = MODES.map(([id, label]) => h('button', { class: 'chip mode', type: 'button', onclick: () => { buzz(); P.mode = id; syncControls(); } }, modeIcon(id), label));
$('modes').append(...modeButtons);

/**
 * Slider with a resting point. With `neutral`, the thumb is pulled onto `home`
 * when the finger comes near it and stays there until the finger has clearly
 * moved away, so the resting value is easy to hit. Nothing is skipped: the rest
 * of the track is stretched to cover the whole range. Tap twice to go back to `home`.
 */
function dial({ min, max, home, neutral = false, step, name, label, read, write }) {
  const span = max - min;
  const PAD = 14;   // keeps the thumb fully inside the track
  const PULL = 0.05; // how far either side of the resting point the pull reaches, as a share of the track
  const kn = neutral ? (home - min) / span : null;
  const atHome = (k) => kn != null && Math.abs(k - kn) < 1e-6;
  // finger position along the track (0..1) -> value position, and back
  const toK = (x) => {
    if (kn == null) return x;
    const d = x - kn;
    if (Math.abs(d) <= PULL) return kn;
    return d > 0 ? kn + ((d - PULL) * (1 - kn)) / (1 - kn - PULL) : kn + ((d + PULL) * kn) / (kn - PULL);
  };
  const toX = (k) => {
    if (kn == null || atHome(k)) return k;
    return k > kn ? kn + PULL + ((k - kn) * (1 - kn - PULL)) / (1 - kn) : kn - PULL - ((kn - k) * (kn - PULL)) / kn;
  };

  const text = h('span', { class: 'sl-label' });
  const el = h('div', { class: `slider${neutral ? ' neutral' : ''}`, role: 'slider', tabindex: '0', 'aria-label': name, 'aria-valuemin': min, 'aria-valuemax': max },
    h('div', { class: 'sl-fill' }), neutral && h('div', { class: 'sl-tick' }), h('div', { class: 'sl-thumb' }), text);
  if (neutral) el.style.setProperty('--o', kn);
  let wasHome = false;

  function paint() {
    const v = read();
    const k = clamp((v - min) / span, 0, 1);
    el.style.setProperty('--x', toX(k));
    el.classList.toggle('home', atHome(k));
    el.setAttribute('aria-valuenow', +v.toFixed(2));
    text.textContent = label();
    return atHome(k);
  }
  function commit(v) {
    write(clamp(v, min, max));
    const nowHome = paint();
    if (nowHome && !wasHome) buzz(12); // a tick in the hand as it locks on
    wasHome = nowHome;
  }
  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    return min + toK(clamp((e.clientX - r.left - PAD) / (r.width - PAD * 2), 0, 1)) * span;
  };
  let dragging = false;
  let lastTap = { t: 0, x: 0 };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const twice = e.timeStamp - lastTap.t < 320 && Math.abs(e.clientX - lastTap.x) < 24;
    lastTap = { t: e.timeStamp, x: e.clientX };
    if (twice) {
      commit(home);
      return;
    }
    el.setPointerCapture(e.pointerId);
    dragging = true;
    el.classList.add('drag');
    wasHome = atHome((read() - min) / span);
    commit(fromEvent(e));
  });
  el.addEventListener('pointermove', (e) => { if (dragging) commit(fromEvent(e)); });
  const end = () => {
    dragging = false;
    el.classList.remove('drag');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (dir) commit(read() + dir * (step || span / 40));
    else if (e.key === 'Home') commit(home);
    else return;
    e.preventDefault();
  });
  paint();
  return { el, paint };
}

const ZOOM_LO = Math.log2(0.3), ZOOM_HI = Math.log2(6); // zoom is spread evenly by doublings, so 1× sits well inside the track
const sliders = {
  seg: dial({ min: 2, max: 24, home: DEFAULTS.seg, step: 2, name: 'Mirrors', label: () => (P.mode === 'spiral' ? `Arms: ${Math.round(P.seg / 2)}` : P.mode === 'frames' ? `Frames: ${Math.round(P.seg / 2)}` : P.mode === 'void' ? `Size: ${Math.round(P.seg / 2)}` : FRACTALS.includes(P.mode) ? `Depth: ${Math.round(P.seg / 2)}` : `Mirrors: ${Math.round(P.seg)}`), read: () => P.seg, write: (v) => { P.seg = Math.round(v / 2) * 2; } }),
  spin: dial({ min: -1, max: 1, home: 0, neutral: true, name: 'Spin', label: () => 'Spin', read: () => P.spin, write: (v) => { P.spin = v; } }),
  twist: dial({ min: -1, max: 1, home: 0, neutral: true, name: 'Twist', label: () => 'Twist', read: () => P.twist, write: (v) => { P.twist = v; } }),
  zoom: dial({ min: ZOOM_LO, max: ZOOM_HI, home: 0, neutral: true, name: 'Zoom', label: () => `Zoom ${P.zoom.toFixed(1)}×`, read: () => Math.log2(P.zoom), write: (v) => { P.zoom = clamp(2 ** v, 0.3, 6); } }),
  dive: dial({ min: -1, max: 1, home: 0, neutral: true, name: 'Dive', label: () => (P.dive > 0 ? 'Dive in' : P.dive < 0 ? 'Dive out' : 'Dive'), read: () => P.dive, write: (v) => { P.dive = v; } }),
  trails: dial({ min: 0, max: 1, home: 0, name: 'Trails', label: () => 'Trails', read: () => P.trails, write: (v) => { P.trails = v; } }),
};
$('sliders').append(...Object.values(sliders).map((s) => s.el));

// ---------- colour rails: two strips up the right-hand edge, each with a button that keeps it moving ----------

/**
 * Upright strip. Like dial(): the thumb is pulled onto `home` (the normal setting, marked with a ring)
 * when the finger comes near, and tapping twice goes back there.
 */
function rail({ track, min, max, home, read, write, onReset }) {
  const span = max - min;
  const PAD = 14;
  const PULL = 0.05;
  const kn = (home - min) / span;
  const atHome = (k) => Math.abs(k - kn) < 1e-6;
  const toK = (x) => {
    const d = x - kn;
    if (Math.abs(d) <= PULL) return kn;
    return d > 0 ? kn + ((d - PULL) * (1 - kn)) / (1 - kn - PULL) : kn + ((d + PULL) * kn) / (kn - PULL);
  };
  const toX = (k) => (atHome(k) ? k : k > kn ? kn + PULL + ((k - kn) * (1 - kn - PULL)) / (1 - kn) : kn - PULL - ((kn - k) * (kn - PULL)) / kn);
  track.style.setProperty('--o', kn);
  track.setAttribute('aria-valuemin', min);
  track.setAttribute('aria-valuemax', max);
  const api = { held: false, paint };
  let wasHome = false;

  function paint() {
    const v = read();
    const k = clamp((v - min) / span, 0, 1);
    track.style.setProperty('--k', toX(k));
    track.classList.toggle('home', atHome(k));
    track.setAttribute('aria-valuenow', +v.toFixed(2));
    return atHome(k);
  }
  function commit(v) {
    write(clamp(v, min, max));
    const nowHome = paint();
    if (nowHome && !wasHome) buzz(12);
    wasHome = nowHome;
  }
  const fromEvent = (e) => {
    const r = track.getBoundingClientRect();
    return min + toK(clamp(1 - (e.clientY - r.top - PAD) / (r.height - PAD * 2), 0, 1)) * span;
  };
  let lastTap = { t: 0, y: 0 };
  track.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const twice = e.timeStamp - lastTap.t < 320 && Math.abs(e.clientY - lastTap.y) < 24;
    lastTap = { t: e.timeStamp, y: e.clientY };
    if (twice) {
      onReset();
      return;
    }
    track.setPointerCapture(e.pointerId);
    api.held = true;
    wasHome = atHome((read() - min) / span);
    commit(fromEvent(e));
  });
  track.addEventListener('pointermove', (e) => { if (api.held) commit(fromEvent(e)); });
  const end = () => { api.held = false; };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (dir) commit(read() + dir * span / 40);
    else if (e.key === 'Home') onReset();
    else return;
    e.preventDefault();
  });
  return api;
}

// colour shift: once round the rainbow, normal colours at the bottom
const HUE_TURN = [0, 1 / 16, 1 / 4]; // turns per second: off, slow, fast
const hueRail = rail({
  track: $('hue-track'), min: 0, max: 1, home: 0, read: () => P.hue,
  write: (v) => { P.hue = v; paintHue(); },
  onReset: () => { P.hue = 0; P.hueSpin = 0; syncControls(); }, // back to the true colours, and stay there
});
function paintHue() {
  hueRail.paint();
  $('hue-track').style.setProperty('--c', `hsl(${Math.round(P.hue * 360)} 100% 50%)`);
}
$('hue-cycle').addEventListener('click', () => {
  buzz();
  P.hueSpin = (P.hueSpin + 1) % 3;
  syncControls();
});

// colour strength: black and white at the bottom, vivid at the top, normal marked in between
const SAT_SWING = [0, 1 / 12, 1 / 3]; // swings per second: off, slow, fast
const SAT_MID = 1.1; // the swing goes from black and white (0) up to 2.2 and back
let satPhase = 0;
const satFromPhase = () => SAT_MID + SAT_MID * Math.sin(satPhase);
const satToPhase = () => { satPhase = Math.asin(clamp((P.sat - SAT_MID) / SAT_MID, -1, 1)); }; // carry on from where the thumb is
const satRail = rail({
  track: $('sat-track'), min: 0, max: 2.5, home: 1, read: () => P.sat,
  write: (v) => { P.sat = v; satToPhase(); },
  onReset: () => { P.sat = 1; P.satSpin = 0; syncControls(); },
});
$('sat-cycle').addEventListener('click', () => {
  buzz();
  P.satSpin = (P.satSpin + 1) % 3;
  satToPhase();
  syncControls();
});

function randomize() {
  const r = Math.random;
  Object.assign(P, {
    mode: ['wedge', 'wedge', 'hex', 'tunnel', 'circles', 'spiral', 'frames', 'tri', 'carpet', 'koch', 'bubbles', 'julia', 'void', 'voidmax', 'quantum'][Math.floor(r() * 15)],
    seg: 4 + Math.floor(r() * 9) * 2,
    spin: (r() - 0.5) * 0.8,
    twist: r() < 0.5 ? 0 : (r() - 0.5) * 0.8,
    zoom: 0.7 + r() * 1.8,
    dive: r() < 0.7 ? 0 : (r() - 0.5) * 1.2,
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
    // presets saved before the mirror count meant wedges on screen: keep them looking as they did
    return (JSON.parse(localStorage.getItem(PRESET_KEY)) || []).map((p) => {
      if (!p || p.v2) return p;
      if (p.mode === 'quad') return { ...p, mode: 'wedge', seg: 4, v2: true };
      if (p.mode === 'wedge' || p.mode === 'circles') return { ...p, seg: Math.min(24, p.seg * 2), v2: true };
      return { ...p, v2: true };
    });
  } catch {
    return [];
  }
})();
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
const slotButtons = [0, 1, 2, 3].map((i) => {
  const save = () => {
    presets[i] = { ...P, v2: true };
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    syncControls();
    buzz(20);
    toast(`Preset ${i + 1} saved`);
    // glows green, then settles back to cyan over ten seconds
    b.classList.remove('saved');
    void b.offsetWidth; // restart the fade if it was saved again mid-way
    b.classList.add('saved');
  };
  const b = h('button', { class: 'chip slot', type: 'button', 'aria-label': `Preset ${i + 1}: tap to recall, hold to save`, onclick: () => {
    if (!presets[i]) { save(); return; }
    Object.assign(P, DEFAULTS, presets[i]);
    syncControls();
    toast(`Preset ${i + 1} recalled`);
  } }, String(i + 1));
  onLongPress(b, save);
  b.addEventListener('animationend', () => b.classList.remove('saved'));
  return b;
});

const btn = (label, fn) => h('button', { class: 'chip', type: 'button', onclick: fn }, label);
// camera button, bottom left: flips between the cameras, or goes back to the camera from a photo or video
const camBtn = $('cam-btn');
camBtn.addEventListener('click', async () => {
  buzz();
  if (source?.camera) facing = facing === 'user' ? 'environment' : 'user';
  try {
    await useCamera();
  } catch (e) {
    alert(e.message);
  }
  syncControls();
});
const fileBtn = btn('Photo / video', () => $('file').click());
const freezeBtn = btn('Freeze', () => { frozen = !frozen; syncControls(); });
const invertBtn = btn('Invert', () => { P.invert = !P.invert; syncControls(); });
const beatBtn = btn('Pulse to the beat', () => { P.beat = !P.beat; syncControls(); });
const randomBtn = btn('🎲 Surprise me', randomize);
const resetBtn = btn('Reset', () => { Object.assign(P, DEFAULTS); rot = 0; syncControls(); });
$('buttons').append(randomBtn, freezeBtn, invertBtn, beatBtn, fileBtn, resetBtn, h('span', { class: 'slots', role: 'group', 'aria-label': 'Presets' }, slotButtons));

function syncControls() {
  MODES.forEach(([id], i) => modeButtons[i].classList.toggle('on', P.mode === id));
  for (const s of Object.values(sliders)) s.paint();
  sliders.seg.el.classList.toggle('dim', P.mode === 'off');
  sliders.dive.el.classList.toggle('dim', !DIVES[P.mode]);
  paintHue();
  satRail.paint();
  $('sat-cycle').classList.toggle('on', P.satSpin > 0);
  $('sat-cycle').classList.toggle('fast', P.satSpin === 2);
  $('sat-cycle').setAttribute('aria-label', `Keep the colour strength swinging: ${['off', 'slow', 'fast'][P.satSpin]}`);
  $('hue-cycle').classList.toggle('on', P.hueSpin > 0);
  $('hue-cycle').classList.toggle('fast', P.hueSpin === 2);
  $('hue-cycle').setAttribute('aria-label', `Keep the colours turning: ${['off', 'slow', 'fast'][P.hueSpin]}`);
  freezeBtn.classList.toggle('on', frozen);
  invertBtn.classList.toggle('on', P.invert);
  beatBtn.classList.toggle('on', P.beat);
  const cam = source?.camera ? (facing === 'user' ? 'front' : 'back') : 'off';
  camBtn.dataset.state = cam;
  $('cam-label').textContent = { front: 'Front', back: 'Back', off: 'Camera' }[cam];
  camBtn.setAttribute('aria-label', { front: 'Front camera in use. Switch to the back camera', back: 'Back camera in use. Switch to the front camera', off: 'Use the camera' }[cam]);
  slotButtons.forEach((b, i) => b.classList.toggle('filled', !!presets[i]));
}
syncControls();

$('menu-btn').addEventListener('click', () => {
  if (!started) return;
  $('controls').hidden = !$('controls').hidden;
  $('hue-rail').hidden = $('controls').hidden;
});

// ---------- full screen ----------
// Hides the browser's address bar and tabs. Opened from the Home Screen there
// is no browser around the page to hide, so the button stays away.
{
  const root = document.documentElement;
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const leave = document.exitFullscreen || document.webkitExitFullscreen;
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const fromHomeScreen = navigator.standalone === true || matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  const btn = $('full-btn');
  const tip = $('full-tip');
  let tipTimer = 0;
  const showTip = () => {
    tip.hidden = false;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.hidden = true; }, 7000);
  };
  btn.hidden = fromHomeScreen;
  btn.addEventListener('click', () => {
    tip.hidden = true;
    if (!enter) { showTip(); return; } // iPhone: only the Home Screen route works
    try {
      const done = isFull() ? leave.call(document) : enter.call(root);
      done?.catch?.(showTip);
    } catch {
      showTip();
    }
  });
  const sync = () => {
    const on = isFull();
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
  };
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
}

// ---------- start screen ----------

$('name').value = localStorage.getItem('tm-kaleido-name') || 'Kaleidoscope';
function begin() {
  started = true;
  localStorage.setItem('tm-kaleido-name', $('name').value);
  $('start').hidden = true;
  $('controls').hidden = false;
  $('hue-rail').hidden = false;
  camBtn.hidden = false;
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

// ---------- keep the browser from zooming the page ----------
// Safari ignores user-scalable=no, so every route to a page zoom is blocked here:
// pinch (gesture events, and two-finger moves that start off the canvas),
// double-tap, and ctrl/cmd + wheel from a trackpad or keyboard.
for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });
// If the page ends up zoomed anyway, snap it back: rewriting the viewport tag makes Safari reset its scale.
const viewportTag = document.querySelector('meta[name="viewport"]');
const viewportContent = viewportTag?.content;
window.visualViewport?.addEventListener('resize', () => {
  if (!viewportTag || touches.size || window.visualViewport.scale <= 1.01) return;
  viewportTag.content = `${viewportContent}, minimum-scale=1`;
  requestAnimationFrame(() => { viewportTag.content = viewportContent; });
});

// hooks for the end-to-end test
window.__kaleido = {
  net, streamer, P, randomize,
  /** Put the endless dive at a point in its loop, 0..1. */
  diveTo(phase) { divePhase = phase; },
  /** Stop all motion and square the pattern up. */
  still() {
    P.spin = 0;
    P.twist = 0;
    P.dive = 0;
    rot = 0;
    syncControls();
  },
};
