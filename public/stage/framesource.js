// Frame-exact playback of a prepared clip.
//
// A <video> element chooses for itself which picture is current, on its own
// clock. Sampled from WebGL that gives uneven motion on some screens (a new
// picture after 1, 2 or 3 refreshes instead of always 2). Here the stage owns
// the clock instead: the prepared MP4 is read directly, decoded with WebCodecs,
// and the stage asks for exactly the frame it wants on every refresh. Forwards,
// backwards and scratching all work the same way.
//
// Only prepared copies are handled (H.264 in MP4, a keyframe every 2 frames,
// written by server/media.js). Anything else stays on the <video> path.

const BLOCK = 4 * 1024 * 1024; // file is read in pieces this big, as needed
const MAX_BLOCKS = 10;
const LEAD = 0.2;              // seconds of pictures kept decoded ahead of the playhead
const MAX_AHEAD = 30;
const MAX_PENDING = 36;

export const canDecodeFrames = typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;

// ---- MP4 reading ----

const type = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Child boxes of the box body spanning [start, end). */
function* boxes(dv, start, end) {
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = end - o;
    if (size < head || o + size > end) return;
    yield { type: type(dv, o + 4), start: o + head, end: o + size };
    o += size;
  }
}

const child = (dv, box, name) => {
  for (const b of boxes(dv, box.start, box.end)) if (b.type === name) return b;
  return null;
};

/**
 * Read the video track's sample table out of a moov box.
 * @param {ArrayBuffer} buf  the moov box body
 * @returns {{ codec, description, width, height, fps, samples: {off,size,key}[] } | null}
 */
export function parseMoov(buf) {
  const dv = new DataView(buf);
  const moov = { start: 0, end: buf.byteLength };
  for (const trak of boxes(dv, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(dv, trak, 'mdia');
    const hdlr = mdia && child(dv, mdia, 'hdlr');
    if (!hdlr || type(dv, hdlr.start + 8) !== 'vide') continue;
    const mdhd = child(dv, mdia, 'mdhd');
    const timescale = dv.getUint8(mdhd.start) === 1 ? dv.getUint32(mdhd.start + 20) : dv.getUint32(mdhd.start + 12);
    const minf = child(dv, mdia, 'minf');
    const stbl = minf && child(dv, minf, 'stbl');
    if (!stbl) return null;
    const t = {};
    for (const b of boxes(dv, stbl.start, stbl.end)) t[b.type] = b;
    if (!t.stsd || !t.stts || !t.stsc || !t.stsz || !(t.stco || t.co64)) return null;

    // codec setup
    const entry = t.stsd.start + 8;
    const fourcc = type(dv, entry + 4);
    if (fourcc !== 'avc1' && fourcc !== 'avc3') return null;
    const width = dv.getUint16(entry + 32);
    const height = dv.getUint16(entry + 34);
    let description = null;
    for (const b of boxes(dv, entry + 86, entry + dv.getUint32(entry))) {
      if (b.type === 'avcC') description = new Uint8Array(buf.slice(b.start, b.end));
    }
    if (!description) return null;
    const hex = (n) => n.toString(16).padStart(2, '0');
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;

    // frame rate: prepared copies are constant rate, so the first run says it all
    const delta = dv.getUint32(t.stts.start + 12);
    const fps = delta ? timescale / delta : 30;

    // sizes
    const fixed = dv.getUint32(t.stsz.start + 4);
    const n = dv.getUint32(t.stsz.start + 8);
    const samples = new Array(n);

    // chunk offsets
    const big = !t.stco;
    const co = big ? t.co64 : t.stco;
    const chunks = dv.getUint32(co.start + 4);
    const chunkOff = (i) => (big ? Number(dv.getBigUint64(co.start + 8 + i * 8)) : dv.getUint32(co.start + 8 + i * 4));

    // which samples sit in which chunk
    const runs = dv.getUint32(t.stsc.start + 4);
    let s = 0;
    for (let r = 0; r < runs && s < n; r++) {
      const first = dv.getUint32(t.stsc.start + 8 + r * 12) - 1;
      const per = dv.getUint32(t.stsc.start + 12 + r * 12);
      const last = r + 1 < runs ? dv.getUint32(t.stsc.start + 8 + (r + 1) * 12) - 1 : chunks;
      for (let c = first; c < last && s < n; c++) {
        let off = chunkOff(c);
        for (let k = 0; k < per && s < n; k++, s++) {
          const size = fixed || dv.getUint32(t.stsz.start + 12 + s * 4);
          samples[s] = { off, size, key: !t.stss };
          off += size;
        }
      }
    }
    if (s !== n) return null;
    if (t.stss) {
      const keys = dv.getUint32(t.stss.start + 4);
      for (let k = 0; k < keys; k++) {
        const i = dv.getUint32(t.stss.start + 8 + k * 4) - 1;
        if (i < n) samples[i].key = true;
      }
    }
    if (!n || !samples[0].key) return null;
    return { codec, description, width, height, fps, samples };
  }
  return null;
}

async function range(url, from, to, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
  if (r.status !== 206) throw new Error(`no range support (${r.status})`);
  return r.arrayBuffer();
}

async function readMoov(url, signal) {
  let pos = 0;
  for (let i = 0; i < 12; i++) {
    const dv = new DataView(await range(url, pos, pos + 15, signal));
    if (dv.byteLength < 8) break;
    let size = dv.getUint32(0);
    let head = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(8));
      head = 16;
    }
    if (type(dv, 4) === 'moov') return range(url, pos + head, pos + size - 1, signal);
    if (size < 8) break;
    pos += size;
  }
  throw new Error('no moov');
}

// ---- the source ----

export class FrameSource {
  // ?frames=0 on the stage address goes back to plain <video> playback
  static enabled = typeof location === 'undefined' || !/[?&]frames=0/.test(location.search);

  constructor(url) {
    this.url = url;
    this.born = performance.now();
    this.ready = false;   // true once a first picture is decoded
    this.failed = false;
    this.closed = false;
    this.fps = 30;
    this.count = 0;
    this.frames = new Map();   // index -> VideoFrame
    this.pending = new Set();  // indices handed to the decoder
    this.blocks = new Map();   // block number -> ArrayBuffer | Promise
    this.shown = null;         // VideoFrame on screen
    this.shownIdx = -1;
    this.keep = new Set();
    this.lastSubmit = 0;
    this.flushing = false;
    this.total = 0;            // distinct pictures shown
    this.missed = 0;           // refreshes where the wanted frame was not ready
    this.abort = new AbortController();
    // what the renderer and the readouts look at, shaped like a <video>
    const self = this;
    this.view = {
      dataset: {},
      readyState: 4,
      networkState: 1,
      paused: false,
      seeking: false,
      currentTime: 0,
      buffered: { length: 0 },
      videoWidth: 0,
      videoHeight: 0,
      get frame() { return self.shown; },
      getVideoPlaybackQuality: () => ({ totalVideoFrames: self.total, droppedVideoFrames: self.missed }),
    };
    this._open().catch(() => this._fail());
  }

  _fail() {
    this.failed = true;
    this.close();
  }

  async _open() {
    const info = parseMoov(await readMoov(this.url, this.abort.signal));
    if (!info || this.closed) throw new Error('unreadable');
    const config = { codec: info.codec, description: info.description, codedWidth: info.width, codedHeight: info.height, optimizeForLatency: true,
      // measured on the show laptop: the hardware decoder hands pictures back 0.3-1 s late, software in ~8 ms
      hardwareAcceleration: 'prefer-software' };
    const ok = await VideoDecoder.isConfigSupported(config);
    if (!ok.supported || this.closed) throw new Error('unsupported');
    this.config = config;
    this.samples = info.samples;
    this.count = info.samples.length;
    this.fps = info.fps;
    this.keyOf = new Int32Array(this.count);
    for (let i = 0, k = 0; i < this.count; i++) {
      if (info.samples[i].key) k = i;
      this.keyOf[i] = k;
    }
    this.view.videoWidth = info.width;
    this.view.videoHeight = info.height;
    this._newDecoder();
    this.opened = true;
  }

  _newDecoder() {
    this.decoder = new VideoDecoder({
      output: (f) => this._output(f),
      error: () => this._fail(),
    });
    this.decoder.configure(this.config);
  }

  _output(frame) {
    const i = frame.timestamp;
    this.pending.delete(i);
    if (this.closed || !this.keep.has(i) || this.frames.has(i)) {
      // not wanted any more (the playhead jumped away): unless nothing at all is showing yet
      if (this.closed || this.shown) {
        frame.close();
        return;
      }
    }
    this.frames.set(i, frame);
    if (!this.shown) this._show(i);
    this.ready = true;
  }

  _show(i) {
    const f = this.frames.get(i);
    if (!f || f === this.shown) return;
    const old = this.shown;
    const oldIdx = this.shownIdx;
    this.shown = f;
    this.shownIdx = i;
    this.total++;
    if (old && !this.keep.has(oldIdx)) {
      this.frames.delete(oldIdx);
      old.close();
    }
  }

  /** Bytes of one sample, or null while its part of the file is still loading. */
  _bytes(s) {
    const b0 = Math.floor(s.off / BLOCK);
    const b1 = Math.floor((s.off + s.size - 1) / BLOCK);
    let have = true;
    for (let b = b0; b <= b1; b++) if (!this._block(b)) have = false;
    if (!have) return null;
    if (b0 === b1) return new Uint8Array(this.blocks.get(b0), s.off - b0 * BLOCK, s.size);
    const out = new Uint8Array(s.size);
    let done = 0;
    for (let b = b0; b <= b1; b++) {
      const from = b === b0 ? s.off - b * BLOCK : 0;
      const part = new Uint8Array(this.blocks.get(b), from, Math.min(BLOCK - from, s.size - done));
      out.set(part, done);
      done += part.length;
    }
    return out;
  }

  /** The loaded block, or null (and it starts loading). */
  _block(b) {
    const have = this.blocks.get(b);
    if (have instanceof ArrayBuffer) {
      this.blocks.delete(b); // most recently used goes last
      this.blocks.set(b, have);
      return have;
    }
    if (!have) {
      const p = range(this.url, b * BLOCK, (b + 1) * BLOCK - 1, this.abort.signal)
        .then((buf) => {
          if (this.closed) return;
          this.blocks.set(b, buf);
          for (const [k, v] of this.blocks) {
            if (this.blocks.size <= MAX_BLOCKS) break;
            if (k !== b && v instanceof ArrayBuffer) this.blocks.delete(k);
          }
        })
        .catch(() => { if (this.blocks.get(b) === p) this.blocks.delete(b); });
      this.blocks.set(b, p);
    }
    return null;
  }

  /**
   * Say which frame should be on screen now and which way playback is heading;
   * decodes what is coming and drops what is behind.
   * @param k       frame index wanted now
   * @param dir     1 forwards, -1 backwards, 0 holding still
   * @param lo, hi  first and last frame of the played section
   * @param bounce  true when playback turns round at the ends instead of wrapping
   * @param speed   how fast the playhead is moving, in clip seconds per second
   */
  want(k, dir = 1, lo = 0, hi = this.count - 1, bounce = false, speed = 1) {
    if (!this.opened || this.closed) return;
    const last = this.count - 1;
    k = Math.min(last, Math.max(0, k));
    lo = Math.min(last, Math.max(0, lo));
    hi = Math.min(last, Math.max(lo, hi));

    // frames to have ready, nearest first
    const need = [k];
    if (dir === 0) {
      need.push(Math.min(last, k + 1), Math.max(0, k - 1));
    } else {
      let i = k;
      let d = dir;
      // look further ahead the faster it goes, so the decoder's delay never shows
      const ahead = Math.min(MAX_AHEAD, Math.max(6, Math.ceil(LEAD * this.fps * speed)));
      for (let n = 0; n < ahead; n++) {
        i += d;
        if (i > hi) {
          if (bounce) { d = -1; i = Math.max(lo, hi - 1); } else i = lo;
        } else if (i < lo) {
          if (bounce) { d = 1; i = Math.min(hi, lo + 1); } else i = hi;
        }
        need.push(i);
      }
    }
    const keep = new Set(need);
    for (let i = Math.max(0, k - 2); i <= Math.min(last, k + 2); i++) keep.add(i);
    this.keep = keep;

    // a jump (scratch, retrigger, new section): forget what the decoder was working on
    if (this.pending.size) {
      let stale = true;
      for (const i of this.pending) if (keep.has(i)) { stale = false; break; }
      if (stale) {
        try { this.decoder.reset(); this.decoder.configure(this.config); } catch { this._fail(); return; }
        this.pending.clear();
        this.flushing = false;
      }
    }

    // drop decoded frames that are no longer near the playhead
    for (const [i, f] of this.frames) {
      if (!keep.has(i) && f !== this.shown) {
        f.close();
        this.frames.delete(i);
      }
    }

    // decode what is missing, a whole keyframe group at a time
    const now = performance.now();
    if (!this.flushing) {
      for (const i of need) {
        if (this.frames.has(i) || this.pending.has(i)) continue;
        if (this.pending.size >= MAX_PENDING) break;
        const g = this.keyOf[i];
        let end = g + 1;
        while (end <= last && !this.samples[end].key) end++;
        const parts = [];
        for (let j = g; j < end; j++) {
          const data = this._bytes(this.samples[j]);
          if (!data) { parts.length = 0; break; }
          parts.push(data);
        }
        if (!parts.length) continue; // still loading from disk
        try {
          for (let j = g; j < end; j++) {
            this.decoder.decode(new EncodedVideoChunk({ type: j === g ? 'key' : 'delta', timestamp: j, data: parts[j - g] }));
            this.pending.add(j);
          }
        } catch { this._fail(); return; }
        this.lastSubmit = now;
      }
      // a decoder may hold the last pictures back waiting for more input: when
      // nothing new is going in (paused, end of a scratch), ask for them
      if (this.pending.size && !this.frames.has(k) && now - this.lastSubmit > 60 && this.decoder.decodeQueueSize === 0) {
        this.flushing = true;
        this.decoder.flush().catch(() => {}).finally(() => { this.flushing = false; this.pending.clear(); });
      }
    }

    // put the wanted frame on screen, or the nearest one that is ready
    if (this.frames.has(k)) this._show(k);
    else {
      if (this.ready) this.missed++;
      let best = -1;
      for (const i of this.frames.keys()) if (best < 0 || Math.abs(i - k) < Math.abs(best - k)) best = i;
      if (best >= 0 && (this.shownIdx < 0 || Math.abs(best - k) < Math.abs(this.shownIdx - k))) this._show(best);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.abort.abort();
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* already gone */ }
    for (const f of this.frames.values()) f.close();
    if (this.shown && !this.frames.has(this.shownIdx)) this.shown.close();
    this.frames.clear();
    this.pending.clear();
    this.blocks.clear();
    this.shown = null;
  }
}
