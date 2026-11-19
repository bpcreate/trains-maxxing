import test from 'node:test';
import assert from 'node:assert/strict';
import { Autopilot } from '../../server/autopilot.js';
import { defaultState, reduce } from '../../shared/state.js';

// Deterministic pseudo-random numbers so runs are repeatable.
function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function rig({ chaos = 0.5, sources = ['c1', 'c2', 'c3', 'c4', 'c5'], seed = 1 } = {}) {
  const state = defaultState();
  state.tempo = { bpm: 120, t0: 0, mic: false };
  state.auto.chaos = chaos;
  let now = 0;
  const log = [];
  const auto = new Autopilot({
    getState: () => state,
    dispatch: (a) => {
      assert.ok(reduce(state, a), `autopilot sent an invalid action: ${JSON.stringify(a)}`);
      log.push({ at: now, ...a });
    },
    getSources: () => sources,
    now: () => now,
    rand: seeded(seed),
  });
  const run = (ms) => {
    const end = now + ms;
    while (now < end) {
      now += 50;
      auto.tick();
    }
  };
  return { state, auto, log, run, at: () => now };
}

test('does nothing while switched off', () => {
  const r = rig();
  r.run(20000);
  assert.equal(r.log.length, 0);
});

test('fills the live deck straight away, then cuts to fresh clips', () => {
  const r = rig();
  r.state.auto.on = true;
  r.run(100);
  assert.ok(r.state.layers.A.src, 'deck A gets a clip immediately');
  r.run(120000);
  const loads = r.log.filter((a) => a.type === 'load' && (a.layer === 'A' || a.layer === 'B'));
  assert.ok(loads.length >= 4, `expected several cuts in two minutes, got ${loads.length}`);
  // the incoming clip always goes on the deck that is hidden at that moment
  const layers = new Set(loads.map((a) => a.layer));
  assert.deepEqual([...layers].sort(), ['A', 'B']);
  // and never the same clip twice in a row on the same deck
  for (let i = 1; i < loads.length; i++) assert.notEqual(loads[i].src, loads[i - 1].src);
});

test('the crossfader travels all the way across after a cut', () => {
  const r = rig({ chaos: 0.1 });
  r.state.auto.on = true;
  r.run(60000);
  const xs = r.log.filter((a) => a.path === 'xfade').map((a) => a.value);
  assert.ok(xs.includes(1), 'reached B');
  assert.ok(xs.every((v) => v >= 0 && v <= 1));
});

test('more chaos means more cuts and more effects', () => {
  const count = (chaos) => {
    const r = rig({ chaos, seed: 7 });
    r.state.auto.on = true;
    r.run(180000);
    return {
      cuts: r.log.filter((a) => a.type === 'load' && a.layer !== 'C').length,
      fx: r.log.filter((a) => /^fx\..*\.on$/.test(a.path) && a.value === true).length,
    };
  };
  const chill = count(0.05);
  const wild = count(0.95);
  assert.ok(wild.cuts > chill.cuts * 2, `cuts: chill ${chill.cuts}, wild ${wild.cuts}`);
  assert.equal(chill.fx, 0, 'fully chill uses no effects');
  assert.ok(wild.fx > 5, `wild fx ${wild.fx}`);
});

test('a manual touch pauses autopilot on that control for ten seconds', () => {
  const r = rig({ chaos: 0.9 });
  r.state.auto.on = true;
  r.run(8000);
  const before = r.log.length;
  r.auto.touch('decks');
  r.auto.touch('xfade');
  r.auto.touch('fx');
  r.auto.touch('overlay');
  r.run(9000);
  const during = r.log.slice(before).filter((a) => a.at > r.at() - 8500);
  assert.deepEqual(during.filter((a) => a.type === 'load' || a.path === 'xfade' || /^fx\..*\.on$/.test(a.path) && a.value), [], 'hands off while held');
  r.run(30000);
  assert.ok(r.log.slice(before).some((a) => a.type === 'load'), 'carries on afterwards');
});

test('switching off tidies up the effects it turned on', () => {
  const r = rig({ chaos: 1, seed: 3 });
  r.state.auto.on = true;
  r.run(90000);
  r.state.auto.on = false;
  r.run(200);
  const mine = new Set(r.log.filter((a) => /^fx\..*\.on$/.test(a.path) && a.value).map((a) => a.path.split('.')[1]));
  for (const id of mine) assert.equal(r.state.fx[id].on, false, `${id} left on`);
  for (const [id, on] of Object.entries(r.state.mom)) assert.equal(on, false, `${id} left held`);
});

test('a jump in the beat counter does not stall it or leave a hold effect stuck', () => {
  const r = rig({ chaos: 1, seed: 5 });
  r.state.auto.on = true;
  r.run(20000);
  // beat zero moves an hour into the future: the counter drops by thousands of beats
  r.state.tempo.t0 += 3600000;
  const before = r.log.length;
  r.run(40000);
  assert.ok(r.log.slice(before).some((a) => a.type === 'load'), 'keeps cutting after the jump');
  // nothing may be held for longer than a couple of beats
  let since = null;
  for (const a of r.log) {
    if (!/^mom\./.test(a.path || '')) continue;
    if (a.value) since ??= a.at;
    else {
      assert.ok(a.at - since < 2000, `hold effect stayed on for ${a.at - since} ms`);
      since = null;
    }
  }
});

test('with an empty library it waits quietly', () => {
  const r = rig({ sources: [] });
  r.state.auto.on = true;
  r.run(60000);
  assert.equal(r.log.filter((a) => a.type === 'load').length, 0);
});

test('groupOf maps actions to control groups', () => {
  assert.equal(Autopilot.groupOf({ type: 'set', path: 'xfade', value: 1 }), 'xfade');
  assert.equal(Autopilot.groupOf({ type: 'set', path: 'layers.A.rate', value: 1 }), 'decks');
  assert.equal(Autopilot.groupOf({ type: 'set', path: 'layers.D.opacity', value: 1 }), 'overlay');
  assert.equal(Autopilot.groupOf({ type: 'set', path: 'fx.rgb.on', value: true }), 'fx');
  assert.equal(Autopilot.groupOf({ type: 'load', layer: 'C' }), 'overlay');
  assert.equal(Autopilot.groupOf({ type: 'set', path: 'auto.chaos', value: 1 }), null);
});
