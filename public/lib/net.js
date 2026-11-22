// Shared WebSocket client: keeps a live mirror of the show state, reconnects
// by itself, and sends actions (with throttling for sliders).

import { reduce, defaultState } from '../shared/state.js';

// Where the app lives on this address: '' normally, '/trains' when it is served as part of a bigger site.
// Every page sits one folder down (/stage/, /remote/, /kaleido/), so it is the page's folder with the last part removed.
export const BASE = new URL('..', location.href).pathname.replace(/\/$/, '');

export class Net {
  constructor(role) {
    this.role = role;
    this.base = BASE;
    this.state = defaultState();
    this.clips = [];
    this.clipsById = new Map();
    this.lives = [];
    this.peers = { stages: 0, remotes: 0 };
    this.cache = 0;
    this.info = {};
    this.canPrep = true;
    this.you = null;
    this.connected = false;
    this.everConnected = false;
    this.offset = 0; // server clock minus local clock
    this._rtt = Infinity; // round trip of the measurement the offset came from
    setInterval(() => this._ping(), 5000);
    this.handlers = {};
    this._pending = new Map(); // path -> value waiting to be sent
    this._timer = null;
    const q = new URLSearchParams(location.search);
    this.key = q.get('k') || localStorage.getItem('tm-key') || '';
    if (q.get('k')) localStorage.setItem('tm-key', q.get('k'));
    this._open();
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  emit(type, ...args) {
    for (const fn of this.handlers[type] || []) fn(...args);
  }

  /** Server time in ms (beat clock reference). */
  now() {
    return Date.now() + this.offset;
  }

  /** Measure the server clock; the quickest round trip gives the best answer. */
  _ping() {
    this._rtt *= 1.2; // let an old measurement be replaced as clocks drift
    this.send({ t: 'ping', c: performance.now() });
  }

  _open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws?role=${this.role}&k=${encodeURIComponent(this.key)}`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onMessage(m);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was) this.emit('status');
      setTimeout(() => this._open(), 1000);
    };
    ws.onerror = () => {};
  }

  _setClips(clips) {
    if (BASE) {
      for (const c of clips) for (const f of ['url', 'proxy', 'thumb', 'strip']) if (c[f]) c[f] = BASE + c[f];
    }
    this.clips = clips;
    this.clipsById = new Map(clips.map((c) => [c.id, c]));
  }

  _onMessage(m) {
    switch (m.t) {
      case 'hello':
        this.you = m.you;
        this.state = m.state;
        this.offset = m.now - Date.now();
        this._rtt = Infinity;
        for (const ms of [0, 300, 900, 2000]) setTimeout(() => this._ping(), ms);
        this.info = m.info || {};
        this.cache = m.cache || 0;
        this.canPrep = m.canPrep !== false;
        this._setClips(m.clips);
        this.connected = true;
        this.everConnected = true;
        this.emit('status');
        this.emit('clips');
        this.emit('state', null);
        break;
      case 'act':
        if (m.by === this.you) break; // already applied locally
        if (reduce(this.state, m.a)) this.emit('state', m.a);
        break;
      case 'clips':
        this._setClips(m.clips);
        this.cache = m.cache || 0;
        this.emit('clips');
        break;
      case 'pong': {
        const rtt = performance.now() - m.c;
        if (rtt >= 0 && rtt <= this._rtt) {
          this._rtt = rtt;
          this.offset = m.s + rtt / 2 - Date.now();
        }
        break;
      }
      case 'peers':
        this.peers = m;
        this.lives = m.lives || [];
        this.emit('peers');
        break;
      default:
        this.emit(m.t, m);
    }
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  /** Apply an action locally right away and tell the server. */
  act(a) {
    if (!reduce(this.state, a)) return;
    this.send({ t: 'act', a });
    this.emit('state', a);
  }

  /** Set one value. Rapid changes to the same path (sliders) are sent at ~30 Hz. */
  set(path, value) {
    const a = { type: 'set', path, value };
    if (!reduce(this.state, a)) return;
    this.emit('state', a);
    this._pending.set(path, value);
    if (!this._timer) {
      this._flush();
      this._timer = setInterval(() => {
        if (this._pending.size) this._flush();
        else {
          clearInterval(this._timer);
          this._timer = null;
        }
      }, 33);
    }
  }

  _flush() {
    for (const [path, value] of this._pending) this.send({ t: 'act', a: { type: 'set', path, value } });
    this._pending.clear();
  }
}
