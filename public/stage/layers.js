// One LayerPlayer per layer (A, B, C, D). It owns two <video> elements so the
// next clip can load in the background and swap in without a black flash, and
// it drives playback: normal speed uses the browser's own playback; reverse,
// shunting and scratching are done by seeking every frame (smooth on proxies).

import { FrameSource, canDecodeFrames } from './framesource.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const STEP_FPS = 30;

function makeVideo() {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.disablePictureInPicture = true;
  return v;
}

export class LayerPlayer {
  constructor(id, { onNeed }) {
    this.id = id;
    this.onNeed = onNeed;      // called with a clip id when its original file will not play
    this.cur = makeVideo();
    this.next = makeVideo();
    this.curKey = null;        // clip id showing now
    this.curUrl = null;
    this.nextKey = null;       // clip id loading / preloaded
    this.nextUrl = null;
    this.failed = new Set();   // urls that errored
    this.liveEl = null;        // <video> of a live input, when the source is live
    this.pos = 0;              // seconds
    this.dir = 1;              // shunt direction
    this.seq = null;
    this.scrub = null;         // { pos (0..1), vel, coast }
    this.audioOk = false;
    // the two elements trade places, so look at which one actually errored
    for (const el of [this.cur, this.next]) el.addEventListener('error', () => this._failed(el));
  }

  _failed(el) {
    const isNext = el === this.next;
    const url = isNext ? this.nextUrl : this.curUrl;
    const key = isNext ? this.nextKey : this.curKey;
    if (!url) return;
    this.failed.add(url);
    if (url.startsWith('/media/') && key) this.onNeed(key);
    if (isNext) {
      this.nextUrl = null;
      this.nextKey = null;
    }
  }

  /** The element to draw, or null. */
  get el() {
    if (this.liveEl) return this.liveEl;
    if (!this.curKey) return null;
    const fs = this._fs();
    return fs ? fs.view : this.cur;
  }

  /** The frame-exact decoder for the clip showing now, once it has a picture. */
  _fs() {
    const fs = this.cur._fs;
    return fs && fs.ready && !fs.failed ? fs : null;
  }

  get isLive() {
    return !!this.liveEl;
  }

  get duration() {
    const d = this.cur.duration;
    return this.curKey && Number.isFinite(d) && d > 0 ? d : 0;
  }

  /** Normalised position 0..1 for the phone's playhead. */
  get progress() {
    const d = this.duration;
    return d ? clamp(this.pos / d, 0, 1) : 0;
  }

  _load(el, url, hdr = false) {
    // HDR original (proxies are tone mapped already): the renderer converts it
    el.dataset.hdr = hdr && url.startsWith('/media/') ? '1' : '';
    el.src = url;
    el.load();
    // prepared copies are decoded by the stage itself, frame by frame (see framesource.js)
    if (el._fs) el._fs.close();
    el._fs = canDecodeFrames && FrameSource.enabled && url.startsWith('/cache/') && url.includes('.mp4') ? new FrameSource(url) : null;
  }

  _unload(el) {
    if (el._fs) el._fs.close();
    el._fs = null;
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  /** Bring the video elements in line with what the state asks for. */
  sync(layer, clipsById, liveVideos) {
    const want = layer.src;
    if (want && want.startsWith('live:')) {
      this.liveEl = liveVideos.get(want.slice(5)) || null;
      if (this.curKey) {
        this._unload(this.cur);
        this.curKey = this.curUrl = null;
      }
      this.seq = layer.seq;
      return;
    }
    this.liveEl = null;
    const clip = want ? clipsById.get(want) : null;
    if (!clip) {
      if (this.curKey) {
        this._unload(this.cur);
        this.curKey = this.curUrl = null;
      }
      this._preload(layer.cue, clipsById);
      return;
    }
    let url = clip.proxy || clip.url;
    if (this.failed.has(url)) url = null;

    if (url && (this.curKey !== want || this.curUrl !== url)) {
      if (this.nextUrl !== url) {
        this.nextKey = want;
        this.nextUrl = url;
        this._load(this.next, url, clip.hdr);
      } else if (this.next.readyState >= 2 && this._primed(this.next, layer)) {
        // ready: swap it in
        const sameClip = this.curKey === want;
        const keep = sameClip ? this.pos : null; // same clip, better file: stay where we are
        this.cur.pause();
        [this.cur, this.next] = [this.next, this.cur];
        this.curKey = want;
        this.curUrl = url;
        this.nextKey = this.nextUrl = null;
        this._unload(this.next);
        const d = this.cur.duration || 0;
        this.pos = keep != null ? Math.min(keep, d) : layer.in * d;
        if (!sameClip) this.dir = 1;
        if (this.pos > 0.01) this.cur.currentTime = this.pos;
        this.seq = layer.seq;
        this.scrub = null;
      }
    } else if (this.curKey === want) {
      this._preload(layer.cue, clipsById);
      if (this.seq !== layer.seq) {
        // retrigger: back to the in-point
        this.seq = layer.seq;
        this.pos = layer.in * this.duration;
        this.dir = 1;
        this.scrub = null;
        this.cur.currentTime = this.pos;
      }
    }
  }

  /** True once the spare element's decoder has its first picture (or is not in use). */
  _primed(el, layer) {
    const fs = el._fs;
    if (!fs || fs.failed || fs.ready) return true;
    if (performance.now() - fs.born > 1500) return true; // slow to start: begin on plain playback
    const same = this.curKey === this.nextKey;
    const t = same ? this.pos : layer.in * (el.duration || 0);
    fs.want(Math.floor(t * fs.fps), 1);
    return false;
  }

  /** Load a cued clip into the spare element so GO can start it instantly. */
  _preload(cue, clipsById) {
    if (!cue || cue.startsWith('live:')) return;
    const clip = clipsById.get(cue);
    if (!clip) return;
    const url = clip.proxy || clip.url;
    if (this.failed.has(url) || this.nextUrl === url) return;
    this.nextKey = cue;
    this.nextUrl = url;
    this._load(this.next, url, clip.hdr);
  }

  /** Scratch messages from the phone. pos is 0..1 of the clip, vel is per second. */
  jog({ pos, vel, end }) {
    if (!this.curKey || this.isLive) return;
    if (!Number.isFinite(pos)) pos = this.scrub ? this.scrub.pos : this.progress;
    if (!Number.isFinite(vel)) vel = 0;
    if (!end) {
      this.scrub = { pos: clamp(pos, 0, 1), vel: 0, coast: false };
    } else if (this.scrub && Math.abs(vel) * this.duration > 0.6) {
      this.scrub.vel = vel; // thrown: keep rolling and slow down
      this.scrub.coast = true;
    } else {
      this._release();
    }
  }

  _release() {
    if (this.scrub) {
      this.pos = this.scrub.pos * this.duration;
      this.cur.currentTime = this.pos;
    }
    this.scrub = null;
  }

  _seek(t) {
    const v = this.cur;
    if (!Number.isFinite(t) || v.seeking) return;
    // Step on the clip's frame grid (prepared copies are 30 fps): ask for the
    // middle of each frame, once. Seeking to arbitrary times asked for the same
    // frame twice and skipped others, which made reverse and scratching judder.
    const frame = Math.floor(t * STEP_FPS);
    const target = Math.min((frame + 0.5) / STEP_FPS, Math.max(0, (v.duration || t) - 0.001));
    if (Math.abs(v.currentTime - target) > 0.002) v.currentTime = target;
  }

  _want(fs, dir, inT, outT, bounce, speed = 1) {
    const f = fs.fps;
    fs.view.currentTime = this.pos;
    fs.want(Math.floor(this.pos * f + 1e-6), dir, Math.ceil(inT * f), Math.floor(outT * f) - 1, bounce, speed);
  }

  /**
   * Playback on the stage's own clock, for clips the stage decodes itself:
   * the playhead moves by exactly rate x dt and the matching frame is shown.
   */
  _tickFrames(fs, rate, dt, layer, ctx, inT, outT, audible) {
    const v = this.cur;
    const end = outT - 0.04;
    const shunt = layer.mode === 'shunt';
    if (rate > 0) {
      this.pos += rate * dt;
      if (this.pos < inT) this.pos = inT;
      if (this.pos >= end) {
        if (shunt) {
          if (layer.shuntBeats <= 0) this.dir = -this.dir;
          this.pos = end; // beat-synced: hold here until the beat turns us round
        } else if (layer.mode === 'once') {
          this.pos = end;
        } else {
          this.pos = inT + Math.min(this.pos - end, Math.max(0, end - inT));
        }
      }
    } else if (rate < 0) {
      this.pos += rate * dt;
      if (this.pos <= inT) {
        if (shunt) {
          this.pos = inT;
          if (layer.shuntBeats <= 0) this.dir = -this.dir;
        } else if (layer.mode === 'once' && !ctx.rewind) {
          this.pos = inT;
        } else {
          this.pos = end;
        }
      }
      if (this.pos > outT) this.pos = end;
    }
    this._want(fs, Math.sign(rate), inT, outT, shunt && !ctx.rewind, Math.abs(rate));

    // the <video> only supplies sound here, and only for plain forward play
    if (audible && rate > 0 && Math.abs(rate - 1) < 0.26) {
      if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = rate;
      if (Math.abs(v.currentTime - this.pos) > 0.25 && !v.seeking) v.currentTime = this.pos;
      if (v.paused && !v.seeking) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }

  /**
   * Advance playback by dt seconds.
   * @param layer  layer state
   * @param ctx    { beat, rewind, audible (0..1) }
   */
  tick(dt, layer, ctx) {
    if (this.isLive || !this.curKey) return;
    const v = this.cur;
    const d = this.duration;
    if (!d) return;

    const vol = this.audioOk ? layer.vol * ctx.audible : 0;
    v.muted = vol <= 0.001;
    if (!v.muted) v.volume = clamp(vol, 0, 1);

    const inT = layer.in * d;
    const outT = Math.max(inT + 0.05, layer.out * d);
    const fs = this._fs();

    if (this.scrub) {
      const sc = this.scrub;
      if (sc.coast) {
        sc.pos = clamp(sc.pos + sc.vel * dt, 0, 1);
        sc.vel *= Math.exp(-dt * 2.5);
        if (sc.pos <= 0 || sc.pos >= 1 || Math.abs(sc.vel) * d < 0.4) {
          this._release();
          return;
        }
      }
      if (!v.paused) v.pause();
      const moved = sc.pos * d - this.pos;
      this.pos = sc.pos * d;
      // decode ahead in whichever direction the finger is dragging
      if (fs) this._want(fs, Math.abs(moved) > 1e-4 ? Math.sign(moved) : 0, 0, d, false, Math.abs(moved) / dt);
      else this._seek(this.pos);
      return;
    }

    let rate = layer.playing ? layer.rate : 0;
    if (layer.mode === 'shunt') {
      if (layer.shuntBeats > 0) this.dir = Math.floor(ctx.beat / layer.shuntBeats) % 2 === 0 ? 1 : -1;
      rate *= this.dir;
    }
    if (ctx.rewind) rate = -2;

    if (fs) {
      this._tickFrames(fs, rate, dt, layer, ctx, inT, outT, !v.muted);
      return;
    }

    if (rate > 0) {
      // forwards: let the browser play
      if (Math.abs(v.playbackRate - rate) > 0.001) v.playbackRate = clamp(rate, 0.0625, 4);
      if (v.currentTime < inT - 0.05) v.currentTime = inT;
      if (v.currentTime >= outT - 0.04 || v.ended) {
        if (layer.mode === 'shunt') {
          if (layer.shuntBeats > 0) {
            v.pause(); // hold at the end until the beat turns us round
          } else {
            this.dir = -this.dir;
          }
          this.pos = outT - 0.04;
          return;
        }
        if (layer.mode === 'once') {
          v.pause();
          this.pos = outT;
          return;
        }
        v.currentTime = inT;
      }
      if (v.paused && !v.seeking) v.play().catch(() => {});
      this.pos = v.currentTime;
    } else if (rate < 0) {
      // backwards: step the playhead ourselves
      if (!v.paused) v.pause();
      this.pos += rate * dt;
      if (this.pos <= inT) {
        if (layer.mode === 'shunt') {
          this.pos = inT;
          if (layer.shuntBeats <= 0) this.dir = -this.dir;
        } else if (layer.mode === 'once' && !ctx.rewind) {
          this.pos = inT;
        } else {
          this.pos = outT - 0.04;
        }
      }
      if (this.pos > outT) this.pos = outT - 0.04;
      this._seek(this.pos);
    } else {
      if (!v.paused) v.pause();
      this.pos = v.currentTime;
    }
  }
}
