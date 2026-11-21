// GLSL for the stage. Four passes per frame:
//   composite -> scene      (mix the four layers)
//   slit      -> slit buf   (train-panorama strip, only while that effect is on)
//   post      -> feedback   (effects; reads last frame for trails)
//   final     -> screen     (strobe, master level, blackout)

import { FX_IDS } from '../shared/fx.js';

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

// Blend modes, in the order of BLENDS in shared/state.js.
export const COMPOSITE = COMMON + `
uniform sampler2D uT0, uT1, uT2, uT3;
uniform vec4 uHas;     // 1 when the layer has a picture
uniform vec4 uAsp;     // picture aspect (w/h)
uniform ivec4 uFit;    // 0 fill, 1 fit (blurred backdrop), 2 tile, 3 turn 90
uniform vec4 uOp;      // opacity
uniform ivec2 uOBlend; // blend mode of overlays C and D
uniform vec2 uOKey;
uniform float uX;      // crossfader
uniform int uStyle;    // 0 fade, 1 cut, 2 wipe, 3 split
uniform int uABlend;
uniform float uAKey;
uniform float uAspect; // output aspect

vec3 samp(sampler2D t, vec2 uv, float srcAsp, float regAsp, int fit) {
  if (fit == 3) { uv = vec2(1.0 - uv.y, uv.x); regAsp = 1.0 / regAsp; }
  if (fit == 2) {
    float n = max(1.0, floor(regAsp / srcAsp + 0.5));
    float cell = floor(uv.x * n);
    uv.x = fract(uv.x * n);
    if (mod(cell, 2.0) > 0.5) uv.x = 1.0 - uv.x; // mirror every other tile so edges meet
    regAsp /= n;
  }
  float r = regAsp / srcAsp;
  vec2 cov = r > 1.0 ? vec2(1.0, 1.0 / r) : vec2(r, 1.0);
  vec2 uvc = (uv - 0.5) * cov + 0.5;
  if (fit == 1) {
    vec2 con = r > 1.0 ? vec2(r, 1.0) : vec2(1.0, 1.0 / r);
    vec2 uvf = (uv - 0.5) * con + 0.5;
    vec3 bg = textureLod(t, uvc, 5.0).rgb * 0.4;
    vec2 e = step(vec2(0.0), uvf) * step(uvf, vec2(1.0));
    return mix(bg, texture(t, uvf).rgb, e.x * e.y);
  }
  return texture(t, uvc).rgb;
}

vec3 blend(vec3 b, vec3 t, int m, float k) {
  if (m == 1) return min(b + t, 1.0);
  if (m == 2) return 1.0 - (1.0 - b) * (1.0 - t);
  if (m == 3) return b * t;
  if (m == 4) return abs(b - t);
  if (m == 5) return max(b, t);
  if (m == 6) return mix(b, t, smoothstep(k - 0.08, k + 0.08, luma(t)));
  return t;
}

void main() {
  vec2 uv = vUv;
  vec3 col = vec3(0.0);
  if (uStyle == 2) {
    // train wipe: B rolls in from the right and pushes A out
    float edge = 1.0 - uX;
    if (uv.x < edge) col = uHas.x * uOp.x * samp(uT0, vec2(uv.x + uX, uv.y), uAsp.x, uAspect, uFit.x);
    else col = uHas.y * uOp.y * samp(uT1, vec2(uv.x - edge, uv.y), uAsp.y, uAspect, uFit.y);
  } else if (uStyle == 3) {
    // split screen: A left, B right, the slider moves the divider
    float edge = 1.0 - uX;
    if (uv.x < edge) col = uHas.x * uOp.x * samp(uT0, vec2(uv.x / edge, uv.y), uAsp.x, uAspect * edge, uFit.x);
    else col = uHas.y * uOp.y * samp(uT1, vec2((uv.x - edge) / max(uX, 1e-4), uv.y), uAsp.y, uAspect * uX, uFit.y);
  } else {
    vec3 a = uHas.x * uOp.x * samp(uT0, uv, uAsp.x, uAspect, uFit.x);
    vec3 b = uHas.y * uOp.y * samp(uT1, uv, uAsp.y, uAspect, uFit.y);
    float x = uStyle == 1 ? step(0.5, uX) : uX;
    if (uABlend == 0) {
      col = mix(a, b, x);
    } else {
      // A alone at the left, B alone at the right, both blended in the middle
      vec3 both = blend(a, b, uABlend, uAKey);
      col = x < 0.5 ? mix(a, both, x * 2.0) : mix(both, b, x * 2.0 - 1.0);
    }
  }
  if (uHas.z > 0.5 && uOp.z > 0.0) {
    vec3 c = samp(uT2, uv, uAsp.z, uAspect, uFit.z);
    col = mix(col, blend(col, c, uOBlend.x, uOKey.x), uOp.z);
  }
  if (uHas.w > 0.5 && uOp.w > 0.0) {
    vec3 d = samp(uT3, uv, uAsp.w, uAspect, uFit.w);
    col = mix(col, blend(col, d, uOBlend.y, uOKey.y), uOp.w);
  }
  o = vec4(col, 1.0);
}`;

// The slit buffer scrolls sideways by a few pixels each frame and paints a
// fresh thin strip of the scene at its right edge: a passing train becomes one
// long panorama.
export const SLIT = COMMON + `
uniform sampler2D uOld, uScene;
uniform float uW;   // strip width, as a fraction of the screen
uniform float uPos; // where in the scene the strip is taken from
void main() {
  if (vUv.x >= 1.0 - uW) o = texture(uScene, vec2(uPos + (vUv.x - (1.0 - uW)), vUv.y));
  else o = texture(uOld, vUv + vec2(uW, 0.0));
}`;

const defs = FX_IDS.map((id, i) => `#define F_${id.toUpperCase()} ${i}`).join('\n');

export const POST = COMMON + `
${defs}
#define ON(i) (uOn[i] > 0.5)
uniform sampler2D uScene, uPrev, uSlit;
uniform vec2 uRes;
uniform float uTime;
uniform float uBeat;
uniform float uOn[${FX_IDS.length}];
uniform float uA[${FX_IDS.length}];
uniform float uY[${FX_IDS.length}];
uniform vec2 uScroll;
uniform float uGlitch, uInvert;

vec2 mirrorRep(vec2 u) { return 1.0 - abs(mod(u, 2.0) - 1.0); }

vec3 src(vec2 uv) {
  uv = mirrorRep(uv);
  return ON(F_SLIT) ? texture(uSlit, uv).rgb : texture(uScene, uv).rgb;
}

void main() {
  vec2 uv = vUv;
  float asp = uRes.x / uRes.y;
  float kick = exp(-fract(uBeat) * 5.0); // 1 on the beat, fading until the next

  if (ON(F_PULSE)) {
    uv = (uv - 0.5) / (1.0 + uA[F_PULSE] * 0.35 * kick) + 0.5;
    uv += uY[F_PULSE] * 0.04 * kick * vec2(sin(floor(uBeat) * 37.0), cos(floor(uBeat) * 23.0));
  }
  if (ON(F_SCROLL)) uv += uScroll;
  if (ON(F_MIRROR)) {
    float sh = (uY[F_MIRROR] - 0.5) * 0.6;
    uv.x = 0.5 - abs(uv.x - 0.5) + sh;
    if (uA[F_MIRROR] > 0.5) uv.y = 0.5 - abs(uv.y - 0.5) + sh * 0.5;
  }
  if (ON(F_KALEIDO)) {
    vec2 p = (uv - 0.5) * vec2(asp, 1.0);
    float n = floor(3.0 + uA[F_KALEIDO] * 9.0);
    float seg = 6.28318 / n;
    float ang = atan(p.y, p.x) + (uY[F_KALEIDO] - 0.5) * 6.28318 + uTime * 0.05;
    ang = abs(mod(ang, seg) - seg * 0.5);
    p = length(p) * vec2(cos(ang), sin(ang));
    uv = p / vec2(asp, 1.0) + 0.5;
  }
  if (ON(F_PIXEL)) {
    float px = mix(6.0, 90.0, uA[F_PIXEL] * uA[F_PIXEL]);
    vec2 cells = uRes / px;
    cells.x *= mix(0.3, 1.7, uY[F_PIXEL]); // squash into bricks or slats
    uv = (floor(uv * cells) + 0.5) / cells;
  }
  if (uGlitch > 0.5) {
    float row = floor(uv.y * 24.0);
    float t = floor(uTime * 18.0);
    if (hash(vec2(row, t)) > 0.55) uv.x += (hash(vec2(row + 3.0, t)) - 0.5) * 0.35;
  }
  if (ON(F_VHS)) uv.x += uY[F_VHS] * 0.012 * sin(uv.y * 40.0 + uTime * 6.0) * (0.6 + 0.4 * sin(uTime * 1.7));

  vec3 c;
  float split = (ON(F_RGB) ? uA[F_RGB] * 0.05 : 0.0) + uGlitch * 0.02;
  if (split > 0.0) {
    float an = uY[F_RGB] * 6.28318;
    vec2 d = vec2(cos(an), sin(an) * asp) * split;
    c = vec3(src(uv + d).r, src(uv).g, src(uv - d).b);
  } else {
    c = src(uv);
  }

  if (ON(F_EDGE)) {
    vec2 px = 1.5 / uRes;
    float l = luma(src(uv - vec2(px.x, 0.0)));
    float r = luma(src(uv + vec2(px.x, 0.0)));
    float u = luma(src(uv + vec2(0.0, px.y)));
    float d = luma(src(uv - vec2(0.0, px.y)));
    float e = smoothstep(0.06, 0.4, length(vec2(r - l, u - d)) * 4.0);
    vec3 neon = hsv2rgb(vec3(uY[F_EDGE] + vUv.y * 0.15 + uTime * 0.02, 0.9, 1.0)) * e;
    c = mix(c, neon, uA[F_EDGE]);
  }
  if (ON(F_POSTER)) {
    float lv = mix(8.0, 2.0, uA[F_POSTER]);
    c = pow(c, vec3(mix(1.2, 0.6, uY[F_POSTER])));
    c = floor(c * lv + 0.5) / lv;
  }
  if (ON(F_HUE)) {
    vec3 h = rgb2hsv(c);
    h.x = fract(h.x + uA[F_HUE]);
    h.y = clamp(h.y * uY[F_HUE] * 3.0, 0.0, 1.0);
    c = hsv2rgb(h);
  }
  if (uInvert > 0.5) c = 1.0 - c;
  if (ON(F_VHS)) {
    float g = uA[F_VHS];
    c *= 1.0 - g * 0.35 * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.5708));
    c += g * 0.18 * (hash(vUv * uRes + uTime) - 0.5);
    c = mix(c, luma(c) * vec3(1.05, 1.0, 0.9), g * 0.25);
  }
  if (ON(F_TRAILS)) {
    vec2 pu = (vUv - 0.5) * (1.0 - (uY[F_TRAILS] - 0.5) * 0.04) + 0.5;
    vec3 p = texture(uPrev, pu).rgb;
    c = max(c, p * mix(0.6, 0.985, uA[F_TRAILS]));
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export const FINAL = COMMON + `
uniform sampler2D uTex;
uniform float uMaster, uBlack, uStrobe, uBeat;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  // strobe: two dips per beat, darkening only
  if (uStrobe > 0.5 && fract(uBeat * 2.0) > 0.5) c *= 0.08;
  o = vec4(c * uMaster * (1.0 - uBlack), 1.0);
}`;
