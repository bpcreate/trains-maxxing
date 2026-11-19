// One LayerPlayer per layer (A, B, C, D). It owns two <video> elements so the
// next clip can load in the background and swap in without a black flash, and
// it drives playback: normal speed uses the browser's own playback; reverse,
// shunting and scratching are done by seeking every frame (smooth on proxies).

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
    this.next.addEventListener('error', () => this._failed(this.next));
    this.cur.addEventListener('error', () => this._failed(this.cur));
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
    return this.curKey ? this.cur : null;
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

  _load(el, url) {
    el.src = url;
    el.load();
  }

  _unload(el) {
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
        this._load(this.next, url);
      } else if (this.next.readyState >= 2) {
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

  /** Load a cued clip into the spare element so GO can start it instantly. */
  _preload(cue, clipsById) {
    if (!cue || cue.startsWith('live:')) return;
    const clip = clipsById.get(cue);
    if (!clip) return;
    const url = clip.proxy || clip.url;
    if (this.failed.has(url) || this.nextUrl === url) return;
    this.nextKey = cue;
    this.nextUrl = url;
    this._load(this.next, url);
  }

  /** Scratch messages from the phone. pos is 0..1 of the clip, vel is per second. */
  jog({ pos, vel, end }) {
    if (!this.curKey || this.isLive) return;
    if (!end) {
      this.scrub = { pos: clamp(pos, 0, 1), vel: 0, coast: false };
    } else if (this.scrub && Math.abs(vel || 0) * this.duration > 0.6) {
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
    if (!v.seeking && Math.abs(v.currentTime - t) > 0.012) v.currentTime = t;
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
      this.pos = sc.pos * d;
      this._seek(this.pos);
      return;
    }

    let rate = layer.playing ? layer.rate : 0;
    if (layer.mode === 'shunt') {
      if (layer.shuntBeats > 0) this.dir = Math.floor(ctx.beat / layer.shuntBeats) % 2 === 0 ? 1 : -1;
      rate *= this.dir;
    }
    if (ctx.rewind) rate = -2;

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
