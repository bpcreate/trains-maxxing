// Clip library: scans the media folder, reads metadata, makes thumbnails and
// filmstrips, and builds "proxies" — re-encoded copies with a keyframe every
// other frame, which is what makes backwards playback and scratching smooth.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mts', '.3gp']);
const STRIP_FRAMES = 8;

export function findFfmpeg() {
  const candidates = [process.env.TM_FFMPEG, 'ffmpeg'];
  try {
    candidates.push(createRequire(import.meta.url)('ffmpeg-static'));
  } catch { /* optional dependency not installed */ }
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Parse the text `ffmpeg -i file` prints into clip metadata. */
export function parseProbe(text) {
  const out = { dur: 0, w: 0, h: 0, fps: 0, audio: false };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) out.dur = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const lines = text.split(/\r?\n/);
  const vi = lines.findIndex((l) => /Stream #.*Video:/.test(l) && !/attached pic/.test(l));
  if (vi >= 0) {
    const line = lines[vi];
    const m = /,\s(\d{2,5})x(\d{2,5})(?=[\s,[]|$)/.exec(line);
    if (m) {
      out.w = +m[1];
      out.h = +m[2];
    }
    const f = /([\d.]+)\s*fps/.exec(line);
    if (f) out.fps = +f[1];
    // phone footage is often stored sideways with a rotation flag
    let rot = 0;
    for (let i = vi + 1; i < lines.length && !/^\s*Stream #/.test(lines[i]); i++) {
      const r = /rotate\s*:\s*(-?\d+)/.exec(lines[i]) || /rotation of (-?[\d.]+) degrees/.exec(lines[i]);
      if (r) rot = Math.round(+r[1]);
    }
    if (Math.abs(rot) % 180 === 90) [out.w, out.h] = [out.h, out.w];
  }
  out.audio = /Stream #.*Audio:/.test(text);
  return out;
}

function run(bin, args, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => {
      err += c;
      if (err.length > 200000) err = err.slice(-100000);
    });
    const timer = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.on('error', () => resolve({ code: -1, err }));
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, err });
    });
  });
}

/** Tiny job queue with a concurrency limit; "front" jobs jump the line. */
function makeQueue(limit) {
  const jobs = [];
  let active = 0;
  const pump = () => {
    while (active < limit && jobs.length) {
      const job = jobs.shift();
      active++;
      job().finally(() => {
        active--;
        pump();
      });
    }
  };
  return (job, front = false) => {
    if (front) jobs.unshift(job);
    else jobs.push(job);
    pump();
  };
}

export class Media {
  constructor({ mediaDir, cacheDir, proxyFormat = 'mp4', onChange = () => {} }) {
    this.mediaDir = mediaDir;
    this.cacheDir = cacheDir;
    this.proxyFormat = proxyFormat; // "mp4" (H.264) for real use, "webm" for tests
    this.onChange = onChange;
    this.ffmpeg = findFfmpeg();
    this.clips = new Map(); // id -> clip
    this.files = new Map(); // id -> absolute path
    this.metaQueue = makeQueue(2);
    this.proxyQueue = makeQueue(1);
    this._scanTimer = null;
  }

  async start() {
    await fsp.mkdir(this.mediaDir, { recursive: true });
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await this.scan();
    try {
      fs.watch(this.mediaDir, { recursive: true }, () => this._scanSoon());
    } catch {
      setInterval(() => this.scan(), 15000).unref();
    }
  }

  _scanSoon() {
    clearTimeout(this._scanTimer);
    this._scanTimer = setTimeout(() => this.scan(), 1500);
  }

  list() {
    return [...this.clips.values()].sort((a, b) => a.crate.localeCompare(b.crate) || a.name.localeCompare(b.name));
  }

  filePath(id) {
    return this.files.get(id) || null;
  }

  async scan() {
    const found = new Map();
    const walk = async (dir) => {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
          try {
            const st = await fsp.stat(abs);
            if (st.size === 0) continue;
            const rel = path.relative(this.mediaDir, abs);
            const id = createHash('sha1').update(`${rel}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 12);
            found.set(id, { abs, rel });
          } catch { /* vanished mid-scan */ }
        }
      }
    };
    await walk(this.mediaDir);

    let changed = false;
    for (const id of [...this.clips.keys()]) {
      if (!found.has(id)) {
        this.clips.delete(id);
        this.files.delete(id);
        changed = true;
      }
    }
    for (const [id, { abs, rel }] of found) {
      if (this.clips.has(id)) continue;
      const dir = path.dirname(rel);
      const clip = {
        id,
        name: path.basename(rel, path.extname(rel)),
        crate: dir === '.' ? '' : dir.split(path.sep).join(' / '),
        dur: 0, w: 0, h: 0, portrait: false, audio: false,
        ready: false,           // metadata + thumbnail done
        thumb: null, strip: null,
        url: `/media/${id}`,
        proxy: null,
        prep: 'none',           // none | queued | working | ready | error
      };
      this.clips.set(id, clip);
      this.files.set(id, abs);
      changed = true;
      this.metaQueue(() => this._prepareMeta(clip, abs));
    }
    if (changed) this.onChange();
  }

  _p(id, suffix) {
    return path.join(this.cacheDir, id + suffix);
  }

  async _prepareMeta(clip, abs) {
    if (!this.clips.has(clip.id)) return;
    const metaFile = this._p(clip.id, '.json');
    let meta = null;
    try {
      meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    } catch { /* not cached yet */ }

    if (!meta && this.ffmpeg) {
      const { err } = await run(this.ffmpeg, ['-hide_banner', '-i', abs], { timeout: 30000 });
      meta = parseProbe(err);
      if (meta.dur > 0 && meta.w > 0) await fsp.writeFile(metaFile, JSON.stringify(meta)).catch(() => {});
      else meta = null; // unreadable (maybe still copying) — a later scan retries when the file changes
    }
    if (meta) {
      Object.assign(clip, { dur: meta.dur, w: meta.w, h: meta.h, audio: meta.audio, portrait: meta.h > meta.w });
    }

    if (this.ffmpeg && meta) {
      const thumb = this._p(clip.id, '.jpg');
      if (!fs.existsSync(thumb)) {
        await run(this.ffmpeg, ['-y', '-hide_banner', '-ss', String(meta.dur * 0.3), '-i', abs,
          '-frames:v', '1', '-vf', "scale='if(gt(iw,ih),320,-2)':'if(gt(iw,ih),-2,320)'", '-q:v', '5', thumb], { timeout: 60000 });
      }
      if (fs.existsSync(thumb)) clip.thumb = `/cache/${clip.id}.jpg`;

      const strip = this._p(clip.id, '.strip.jpg');
      if (!fs.existsSync(strip)) {
        // one fast seek per frame, joined side by side
        const args = ['-y', '-hide_banner'];
        for (let i = 0; i < STRIP_FRAMES; i++) {
          args.push('-ss', String((meta.dur * (i + 0.5)) / STRIP_FRAMES), '-i', abs);
        }
        const chains = [];
        for (let i = 0; i < STRIP_FRAMES; i++) {
          chains.push(`[${i}:v]scale=96:54:force_original_aspect_ratio=increase,crop=96:54[s${i}]`);
        }
        const joined = Array.from({ length: STRIP_FRAMES }, (_, i) => `[s${i}]`).join('');
        args.push('-filter_complex', `${chains.join(';')};${joined}hstack=inputs=${STRIP_FRAMES}`, '-frames:v', '1', '-q:v', '6', strip);
        await run(this.ffmpeg, args, { timeout: 120000 });
      }
      if (fs.existsSync(strip)) clip.strip = `/cache/${clip.id}.strip.jpg`;
    }

    const proxy = this._p(clip.id, `.proxy.${this.proxyFormat}`);
    if (fs.existsSync(proxy)) {
      clip.proxy = `/cache/${clip.id}.proxy.${this.proxyFormat}`;
      clip.prep = 'ready';
    }
    clip.ready = true;
    this.onChange();
  }

  /** Ask for a scrub-friendly proxy. `urgent` puts it at the front of the line. */
  prep(id, urgent = false) {
    const clip = this.clips.get(id);
    const abs = this.files.get(id);
    if (!clip || !abs || !this.ffmpeg) return;
    if (clip.prep !== 'none' && clip.prep !== 'error') return;
    clip.prep = 'queued';
    this.onChange();
    this.proxyQueue(() => this._makeProxy(clip, abs), urgent);
  }

  prepAll() {
    for (const clip of this.list()) this.prep(clip.id);
  }

  async _makeProxy(clip, abs) {
    if (!this.clips.has(clip.id)) return;
    clip.prep = 'working';
    this.onChange();
    const ext = this.proxyFormat;
    const out = this._p(clip.id, `.proxy.${ext}`);
    const tmp = this._p(clip.id, `.proxy.part.${ext}`);
    // shorter side at most 720 px, 30 fps, keyframe every 2 frames, no B-frames
    const vf = "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)',fps=30,format=yuv420p";
    const codec = ext === 'webm'
      ? ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2500k', '-g', '2', '-an']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', '2', '-bf', '0',
         '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'];
    const { code } = await run(this.ffmpeg, ['-y', '-hide_banner', '-i', abs, '-vf', vf, ...codec, tmp]);
    if (code === 0 && fs.existsSync(tmp)) {
      await fsp.rename(tmp, out);
      clip.proxy = `/cache/${clip.id}.proxy.${ext}`;
      clip.prep = 'ready';
    } else {
      await fsp.rm(tmp, { force: true });
      clip.prep = 'error';
    }
    this.onChange();
  }

  async cacheBytes() {
    let total = 0;
    try {
      for (const name of await fsp.readdir(this.cacheDir)) {
        total += (await fsp.stat(path.join(this.cacheDir, name))).size;
      }
    } catch { /* empty */ }
    return total;
  }

  /** Delete every proxy (thumbnails stay). */
  async clearProxies() {
    for (const clip of this.clips.values()) {
      if (clip.prep === 'ready') {
        await fsp.rm(this._p(clip.id, `.proxy.${this.proxyFormat}`), { force: true });
        clip.proxy = null;
        clip.prep = 'none';
      }
    }
    this.onChange();
  }
}
