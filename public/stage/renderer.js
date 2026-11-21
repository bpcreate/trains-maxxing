// WebGL2 compositor for the stage.

import { BLENDS, XSTYLES, LAYERS } from '/shared/state.js';
import { FX_IDS } from '/shared/fx.js';
import { VERT, COMPOSITE, SLIT, POST, FINAL } from './shaders.js';

const MAX_W = 1920;
const FIT_CODE = { fill: 0, fit: 1, tile: 2, turn: 3 };

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('This browser has no WebGL2. Use a recent Chrome.');
    this.gl = gl;
    this.progs = {
      composite: program(gl, COMPOSITE),
      slit: program(gl, SLIT),
      post: program(gl, POST),
      final: program(gl, FINAL),
    };
    // one big triangle covering the screen
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    this.black = this._tex(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.layerTex = LAYERS.map(() => ({ tex: this._tex(gl.LINEAR), has: false, asp: 16 / 9, mips: false }));
    this.w = 0;
    this.h = 0;
    this.flip = 0;       // which feedback buffer was written last
    this.slitFlip = 0;
    this.slitWasOn = false;
    this.scroll = [0, 0];
    this.blackLevel = 0;
    this.resize();
  }

  _tex(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _fbo(filter) {
    const gl = this.gl;
    const tex = this._tex(filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fb, tex };
  }

  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    let h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w > MAX_W) {
      h = Math.round((h * MAX_W) / w);
      w = MAX_W;
    }
    if (w === this.w && h === this.h) return;
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    for (const b of this.buffers || []) {
      gl.deleteFramebuffer(b.fb);
      gl.deleteTexture(b.tex);
    }
    this.scene = this._fbo(gl.LINEAR);
    this.fbs = [this._fbo(gl.LINEAR), this._fbo(gl.LINEAR)];
    this.slits = [this._fbo(gl.NEAREST), this._fbo(gl.NEAREST)];
    this.buffers = [this.scene, ...this.fbs, ...this.slits];
  }

  /** Upload the current frame of a layer's video (or mark the layer empty). */
  setLayer(i, video, wantMips) {
    const gl = this.gl;
    const L = this.layerTex[i];
    if (!video) {
      L.has = false;
      L.src = null;
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || (video.frame === null)) {
      // Mid-seek (reverse and scratching seek every frame) the video has no
      // frame to give for a moment: keep the last one instead of going black.
      if (L.src !== video) L.has = false;
      return;
    }
    let src = video;
    if (video.frame) {
      // a clip the stage decodes itself: upload only when the picture changed
      src = video.frame;
      if (L.src === video && L.frame === src && !!wantMips === !!L.mips) return;
      L.frame = src;
    } else L.frame = null;
    L.src = video;
    if (video.dataset && video.dataset.hdr) {
      // WebGL uploads of HDR (HLG/PQ) video skip Chrome's tone mapping and come
      // out flat and grey; a 2D canvas draw applies it, so go through one.
      src = this._sdr(i, video);
    }
    gl.bindTexture(gl.TEXTURE_2D, L.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      L.has = false;
      return;
    }
    if (wantMips) gl.generateMipmap(gl.TEXTURE_2D);
    if (wantMips !== L.mips) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      L.mips = wantMips;
    }
    L.has = true;
    L.asp = video.videoWidth / video.videoHeight;
  }

  _sdr(i, video) {
    this.sdrCanvas = this.sdrCanvas || [];
    let c = this.sdrCanvas[i];
    if (!c) {
      c = this.sdrCanvas[i] = document.createElement('canvas');
      c.g = c.getContext('2d', { alpha: false });
    }
    const s = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * s);
    const h = Math.round(video.videoHeight * s);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    c.g.drawImage(video, 0, 0, w, h);
    return c;
  }

  /** Resolve "auto" fit: fill unless that would crop away most of the picture. */
  fitFor(i, fit) {
    if (fit !== 'auto') return fit;
    const ratio = (this.w / this.h) / this.layerTex[i].asp;
    return ratio > 1.5 || ratio < 0.6 ? 'fit' : 'fill';
  }

  _draw(prog, target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog.p);
  }

  _bind(unit, tex, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  /**
   * Draw one frame.
   * @param s      show state
   * @param frame  { time (s), beat (float), dt (s) }
   */
  render(s, frame) {
    const gl = this.gl;
    const freeze = s.mom.freeze;
    const LT = this.layerTex;

    if (!freeze) {
      // ---- 1. composite the layers ----
      const c = this.progs.composite;
      this._draw(c, this.scene);
      const lay = LAYERS.map((id) => s.layers[id]);
      LAYERS.forEach((id, i) => this._bind(i, LT[i].has ? LT[i].tex : this.black, c.u[`uT${i}`]));
      const vis = [1, 1, lay[2].on ? 1 : 0, lay[3].on ? 1 : 0];
      gl.uniform4f(c.u.uHas, ...LT.map((t, i) => (t.has && vis[i] ? 1 : 0)));
      gl.uniform4f(c.u.uAsp, ...LT.map((t) => t.asp));
      gl.uniform4i(c.u.uFit, ...lay.map((l, i) => FIT_CODE[this.fitFor(i, l.fit)]));
      gl.uniform4f(c.u.uOp, ...lay.map((l) => l.opacity));
      gl.uniform2i(c.u.uOBlend, BLENDS.indexOf(lay[2].blend), BLENDS.indexOf(lay[3].blend));
      gl.uniform2f(c.u.uOKey, lay[2].key, lay[3].key);
      gl.uniform1f(c.u.uX, s.xfade);
      gl.uniform1i(c.u.uStyle, XSTYLES.indexOf(s.xfadeStyle));
      gl.uniform1i(c.u.uABlend, BLENDS.indexOf(s.abBlend));
      gl.uniform1f(c.u.uAKey, lay[1].key);
      gl.uniform1f(c.u.uAspect, this.w / this.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // ---- 2. train panorama strip ----
      const slit = s.fx.slit;
      if (slit.on) {
        const sp = this.progs.slit;
        const dst = this.slits[1 - this.slitFlip];
        this._draw(sp, dst);
        if (!this.slitWasOn) {
          // starting fresh: wipe the old strip so the panorama builds from black
          for (const b of this.slits) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        }
        this._bind(0, this.slits[this.slitFlip].tex, sp.u.uOld);
        this._bind(1, this.scene.tex, sp.u.uScene);
        const px = Math.max(1, Math.round(1 + slit.amt * 14 * Math.min(2, frame.dt * 60)));
        gl.uniform1f(sp.u.uW, px / this.w);
        gl.uniform1f(sp.u.uPos, 0.05 + slit.y * 0.9);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.slitFlip = 1 - this.slitFlip;
      }
      this.slitWasOn = slit.on;

      // ---- 3. effects ----
      const p = this.progs.post;
      const out = this.fbs[1 - this.flip];
      this._draw(p, out);
      this._bind(0, this.scene.tex, p.u.uScene);
      this._bind(1, this.fbs[this.flip].tex, p.u.uPrev);
      this._bind(2, this.slits[this.slitFlip].tex, p.u.uSlit);
      gl.uniform2f(p.u.uRes, this.w, this.h);
      gl.uniform1f(p.u.uTime, frame.time % 3600);
      gl.uniform1f(p.u.uBeat, frame.beat % 1024);
      gl.uniform1fv(p.u.uOn, FX_IDS.map((id) => (s.fx[id].on ? 1 : 0)));
      gl.uniform1fv(p.u.uA, FX_IDS.map((id) => s.fx[id].amt));
      gl.uniform1fv(p.u.uY, FX_IDS.map((id) => s.fx[id].y));
      if (s.fx.scroll.on) {
        // accumulate so changing the speed never makes the picture jump
        this.scroll[0] = (this.scroll[0] + (s.fx.scroll.amt - 0.5) * 1.2 * frame.dt) % 2;
        this.scroll[1] = (this.scroll[1] + (s.fx.scroll.y - 0.5) * 1.2 * frame.dt) % 2;
      }
      gl.uniform2f(p.u.uScroll, this.scroll[0], this.scroll[1]);
      gl.uniform1f(p.u.uGlitch, s.mom.glitch ? 1 : 0);
      gl.uniform1f(p.u.uInvert, s.mom.invert ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.flip = 1 - this.flip;
    }

    // ---- 4. to the screen ----
    const target = s.blackout ? 1 : 0;
    this.blackLevel += Math.sign(target - this.blackLevel) * Math.min(Math.abs(target - this.blackLevel), frame.dt * 1.6);
    const f = this.progs.final;
    this._draw(f, null);
    this._bind(0, this.fbs[this.flip].tex, f.u.uTex);
    gl.uniform1f(f.u.uMaster, s.master);
    gl.uniform1f(f.u.uBlack, this.blackLevel);
    gl.uniform1f(f.u.uStrobe, s.mom.strobe ? 1 : 0);
    gl.uniform1f(f.u.uBeat, frame.beat % 1024);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read one pixel of the output (0..1 coords, origin top-left). For tests. */
  readPixel(x, y) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(Math.floor(x * (this.w - 1)), Math.floor((1 - y) * (this.h - 1)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  }
}
