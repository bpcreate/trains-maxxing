import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leadPos, gap, trimFor } from '../../public/stage/follow.js';
import { Hub } from '../../server/hub.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} should be ${b}`);

test('leadPos runs the leader forward and wraps a loop', () => {
  near(leadPos({ p: 2, v: 1 }, 0.5, 0, 10, true), 2.5);
  near(leadPos({ p: 9.8, v: 1 }, 0.5, 0, 10, true), 0.3);
  near(leadPos({ p: 0.2, v: -1 }, 0.5, 0, 10, true), 9.7);
  near(leadPos({ p: 9.8, v: 2 }, 0.5, 0, 10, false), 10); // shunt and once stop at the end
  near(leadPos({ p: 4, v: 0 }, 1, 0, 10, true), 4);
});

test('gap takes the short way round a loop; trim is gentle and capped', () => {
  near(gap(0.2, 9.9, 0, 10, true), 0.3);
  near(gap(9.9, 0.2, 0, 10, true), -0.3);
  near(gap(9.9, 0.2, 0, 10, false), 9.7);
  assert.equal(trimFor(0.01), 1);
  assert.ok(trimFor(0.1) > 1 && trimFor(0.1) < 1.12);
  near(trimFor(5), 1.12);
  near(trimFor(-5), 0.88);
});

function fakeWs() {
  const ws = { readyState: 1, sent: [], handlers: {}, send(t) { this.sent.push(JSON.parse(t)); }, on(ev, fn) { this.handlers[ev] = fn; }, close() {} };
  ws.say = (msg) => ws.handlers.message(Buffer.from(JSON.stringify(msg)), false);
  ws.got = (t) => ws.sent.filter((m) => m.t === t);
  return ws;
}

test('with two screens the first leads: only it reports to phones, and the other gets its playheads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hub-'));
  const media = { list: () => [], cacheBytes: async () => 0, prep() {}, ffmpeg: null };
  const hub = new Hub({ media, dataDir: dir });
  try {
    const [s1, s2, phone] = [fakeWs(), fakeWs(), fakeWs()];
    await hub.connect(s1, 'stage');
    await hub.connect(s2, 'stage');
    await hub.connect(phone, 'remote');
    const lead = s1.got('hello')[0].you;
    assert.equal(phone.got('peers').at(-1).lead, lead);
    assert.equal(phone.got('peers').at(-1).stages, 2);

    s2.say({ t: 'pos', p: { A: { p: 0.9 } } });
    assert.equal(phone.got('pos').length, 0, 'a following screen must not report to the phone');
    s1.say({ t: 'pos', p: { A: { p: 0.1 } } });
    assert.equal(phone.got('pos').length, 1);

    s1.say({ t: 'sync', at: 5, L: { A: { k: 'x', p: 1, v: 1 } } });
    assert.equal(s2.got('sync').length, 1);
    assert.equal(s1.got('sync').length, 0);
    assert.equal(phone.got('sync').length, 0);
    s2.say({ t: 'sync', at: 6, L: {} });
    assert.equal(s1.got('sync').length, 0, 'a follower cannot steer the leader');

    s1.say({ t: 'ping', c: 42 });
    assert.equal(s1.got('pong')[0].c, 42);

    // the leader goes away: the other screen takes over
    s1.readyState = 3;
    s1.handlers.close();
    assert.equal(phone.got('peers').at(-1).lead, s2.got('hello')[0].you);
    s2.say({ t: 'pos', p: { A: { p: 0.5 } } });
    assert.equal(phone.got('pos').length, 2);
  } finally {
    clearInterval(hub._ticker);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
