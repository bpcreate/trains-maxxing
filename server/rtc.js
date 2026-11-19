// Live inputs (the iPad kaleidoscope, or any phone acting as a camera).
// The video itself travels device-to-laptop over WebRTC; the server only keeps
// the list of who is connected and passes the handshake messages along.

export class LiveRegistry {
  constructor() {
    this.lives = new Map(); // client id -> { id, name, kind }
  }

  add(id, { name, kind }) {
    const clean = (s, max) => String(s || '').replace(/[^\w .\-']/g, '').slice(0, max);
    this.lives.set(id, {
      id,
      src: `live:${id}`,
      name: clean(name, 24) || 'Live input',
      kind: clean(kind, 12) || 'camera',
    });
  }

  remove(id) {
    return this.lives.delete(id);
  }

  has(id) {
    return this.lives.has(id);
  }

  list() {
    return [...this.lives.values()];
  }
}
