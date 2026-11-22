// The hub: owns the authoritative state, applies actions, and keeps every
// connected stage, phone and live input in sync over WebSocket.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { reduce, hydrate, APP_NAME, LAYERS } from '../shared/state.js';
import { Autopilot } from './autopilot.js';
import { TapTempo } from './clock.js';
import { LiveRegistry } from './rtc.js';

const ROLES = new Set(['stage', 'remote', 'kaleido']);

export class Hub {
  constructor({ media, dataDir, info = {} }) {
    this.media = media;
    this.info = info; // urls etc. passed to clients in the hello message
    this.stateFile = path.join(dataDir, 'state.json');
    this.perfFile = path.join(dataDir, 'perf.log');
    this.perfBytes = 0;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch { /* first run */ }
    this.state = hydrate(saved);
    if (!this.state.tempo.t0) this.state.tempo.t0 = Date.now();

    this.clients = new Map(); // id -> { id, role, ws }
    this.nextId = 1;
    this.taps = new TapTempo();
    this.lives = new LiveRegistry();
    this.autopilot = new Autopilot({
      getState: () => this.state,
      dispatch: (a, by) => this.dispatch(a, by),
      getSources: (pool, includeLive) => this.sources(pool, includeLive),
    });
    this._saveTimer = null;
    this._clipsTimer = null;
    this._ticker = setInterval(() => this.autopilot.tick(), 50);
    this._ticker.unref();
  }

  // ---- sources autopilot may choose from ----

  sources(pool, includeLive) {
    let clips = this.media.list().filter((c) => c.ready && c.dur > 0);
    if (pool === 'fav') clips = clips.filter((c) => this.state.favs[c.id]);
    else if (pool?.startsWith('crate:')) clips = clips.filter((c) => c.crate === pool.slice(6));
    const out = clips.map((c) => c.id);
    if (includeLive) for (const l of this.lives.list()) out.push(l.src);
    return out;
  }

  // ---- state ----

  dispatch(action, by = 'server') {
    if (!reduce(this.state, action)) return false;
    this.broadcast({ t: 'act', a: action, by });
    // make sure a clip that is going on screen gets a scrub-friendly proxy
    if (action.type === 'load' && action.src && !action.src.startsWith('live:')) this.media.prep(action.src, true);
    if (action.type === 'go' || action.type === 'scene.load') {
      for (const ly of Object.values(this.state.layers)) {
        if (ly.src && !ly.src.startsWith('live:')) this.media.prep(ly.src, true);
      }
    }
    if (action.type === 'fav' && this.state.favs[action.id]) this.media.prep(action.id);
    this._saveSoon();
    return true;
  }

  _saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      const copy = structuredClone(this.state);
      for (const k of Object.keys(copy.mom)) copy.mom[k] = false;
      try {
        await fsp.writeFile(this.stateFile + '.tmp', JSON.stringify(copy));
        await fsp.rename(this.stateFile + '.tmp', this.stateFile);
      } catch { /* disk hiccup: try again on the next change */ }
    }, 1000);
    this._saveTimer.unref();
  }

  /** Called by the media library whenever clips or their prep status change. */
  clipsChanged() {
    if (this._clipsTimer) return;
    this._clipsTimer = setTimeout(async () => {
      this._clipsTimer = null;
      this.broadcast({ t: 'clips', clips: this.media.list(), cache: await this.media.cacheBytes() });
    }, 150);
  }

  // ---- connections ----

  send(client, msg) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg, role = null, exceptId = null) {
    const text = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (role && c.role !== role) continue;
      if (c.id === exceptId) continue;
      if (c.ws.readyState === 1) c.ws.send(text);
    }
  }

  count(role) {
    let n = 0;
    for (const c of this.clients.values()) if (c.role === role) n++;
    return n;
  }

  /**
   * With more than one big screen open, the one that has been connected longest
   * leads: it reports to the phones and the others follow its playheads.
   */
  leadStage() {
    for (const c of this.clients.values()) if (c.role === 'stage') return c.id; // a Map keeps connection order
    return null;
  }

  _peers() {
    this.broadcast({ t: 'peers', stages: this.count('stage'), remotes: this.count('remote'), lives: this.lives.list(), lead: this.leadStage() });
  }

  async connect(ws, role) {
    if (!ROLES.has(role)) {
      ws.close(1008, 'unknown role');
      return;
    }
    const client = { id: `${role[0]}${this.nextId++}`, role, ws };
    this.clients.set(client.id, client);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        this.onMessage(client, msg);
      } catch (e) {
        console.error('message error', e);
      }
    });
    ws.on('close', () => {
      this.clients.delete(client.id);
      if (this.lives.remove(client.id)) this.broadcast({ t: 'rtc.gone', id: client.id }, 'stage');
      // a phone that dropped off mid-press must not leave Strobe (etc.) stuck on
      if (role === 'remote' && !this.state.auto.on) {
        for (const [id, on] of Object.entries(this.state.mom)) {
          if (on) this.dispatch({ type: 'set', path: `mom.${id}`, value: false });
        }
      }
      this._peers();
    });
    ws.on('error', () => {});

    this.send(client, {
      t: 'hello',
      you: client.id,
      name: APP_NAME,
      now: Date.now(),
      state: this.state,
      clips: this.media.list(),
      cache: await this.media.cacheBytes(),
      info: this.info,
      canPrep: !!this.media.ffmpeg,
    });
    this._peers();
    // a new stage needs a fresh video connection from every live input
    if (role === 'stage') {
      for (const l of this.lives.list()) {
        const live = this.clients.get(l.id);
        if (live) this.send(live, { t: 'rtc.start', stage: client.id });
      }
    }
  }

  onMessage(client, msg) {
    const { role } = client;
    switch (msg.t) {
      case 'act': {
        if (role === 'kaleido') return;
        const a = msg.a;
        if (!a) return;
        if (role === 'remote') {
          const group = Autopilot.groupOf(a);
          if (group) this.autopilot.touch(group);
        }
        this.dispatch(a, client.id);
        return;
      }
      case 'tap': {
        if (role === 'kaleido') return;
        this.dispatch({ type: 'tempo', ...this.taps.tap(Date.now()) }, 'server');
        return;
      }
      case 'jog': {
        // scratching: straight through to the stage, no state involved
        if (role !== 'remote' || !LAYERS.includes(msg.l) || !Number.isFinite(msg.pos)) return;
        this.autopilot.touch(msg.l === 'A' || msg.l === 'B' ? 'decks' : 'overlay');
        this.broadcast({ t: 'jog', l: msg.l, pos: msg.pos, vel: Number.isFinite(msg.vel) ? msg.vel : 0, end: !!msg.end }, 'stage');
        return;
      }
      case 'spray': {
        if (role !== 'remote') return;
        this.broadcast({ t: 'spray', s: msg.s }, 'stage');
        return;
      }
      case 'spray.clear': {
        if (role !== 'remote') return;
        this.broadcast({ t: 'spray.clear' }, 'stage');
        return;
      }
      case 'prep': {
        if (role !== 'remote') return;
        if (msg.id === 'all') this.media.prepAll();
        else this.media.prep(String(msg.id), true);
        return;
      }
      case 'prep.clear': {
        if (role !== 'remote') return;
        this.media.clearProxies();
        return;
      }
      // ---- from the stage ----
      case 'pos':
      case 'preview':
      case 'live.thumb': {
        // only the leading screen reports, or the phone would flicker between two answers
        if (role !== 'stage' || client.id !== this.leadStage()) return;
        this.broadcast(msg, 'remote');
        return;
      }
      case 'sync': {
        // the leading screen's playheads, for any other screens to follow
        if (role !== 'stage' || client.id !== this.leadStage()) return;
        this.broadcast({ t: 'sync', at: msg.at, L: msg.L }, 'stage', client.id);
        return;
      }
      case 'ping': {
        this.send(client, { t: 'pong', c: msg.c, s: Date.now() });
        return;
      }
      case 'perf': {
        // once-a-second playback report from the stage, for chasing stutter after the fact
        if (role !== 'stage' || this.perfBytes > 20e6) return;
        const line = JSON.stringify({ at: new Date().toISOString(), stage: client.id, ...msg.d }).slice(0, 4000) + '\n';
        this.perfBytes += line.length;
        fsp.appendFile(this.perfFile, line).catch(() => {});
        return;
      }
      case 'need': {
        // the stage could not play the original file: it needs the proxy now
        if (role !== 'stage') return;
        this.media.prep(String(msg.id), true);
        return;
      }
      // ---- live inputs ----
      case 'live.hello': {
        if (role !== 'kaleido') return;
        this.lives.add(client.id, { name: msg.name, kind: msg.kind });
        this._peers();
        for (const c of this.clients.values()) {
          if (c.role === 'stage') this.send(client, { t: 'rtc.start', stage: c.id });
        }
        return;
      }
      case 'rtc': {
        // WebRTC handshake relay between a live input and a stage
        const to = this.clients.get(msg.to);
        if (!to) return;
        const ok = (role === 'kaleido' && to.role === 'stage') || (role === 'stage' && to.role === 'kaleido');
        if (ok) this.send(to, { t: 'rtc', from: client.id, d: msg.d });
        return;
      }
      default:
    }
  }
}
