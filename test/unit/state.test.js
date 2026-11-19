import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, reduce, hydrate, validateSet, layerVisible, beatAt, snapshotScene } from '../../shared/state.js';

test('set: accepts known paths and clamps numbers', () => {
  const s = defaultState();
  assert.ok(reduce(s, { type: 'set', path: 'xfade', value: 0.4 }));
  assert.equal(s.xfade, 0.4);
  reduce(s, { type: 'set', path: 'xfade', value: 7 });
  assert.equal(s.xfade, 1);
  reduce(s, { type: 'set', path: 'layers.B.rate', value: -5 });
  assert.equal(s.layers.B.rate, -2);
  assert.ok(reduce(s, { type: 'set', path: 'fx.trails.on', value: true }));
  assert.equal(s.fx.trails.on, true);
});

test('set: rejects unknown paths and wrong types', () => {
  const s = defaultState();
  assert.equal(reduce(s, { type: 'set', path: 'layers.A.src', value: 'x' }), false);
  assert.equal(reduce(s, { type: 'set', path: '__proto__.polluted', value: true }), false);
  assert.equal(reduce(s, { type: 'set', path: 'xfade', value: 'half' }), false);
  assert.equal(reduce(s, { type: 'set', path: 'xfadeStyle', value: 'explode' }), false);
  assert.equal(validateSet('constructor.prototype.x', 1), undefined);
  assert.equal({}.polluted, undefined);
});

test('set: loop points can never cross', () => {
  const s = defaultState();
  reduce(s, { type: 'set', path: 'layers.A.out', value: 0.5 });
  reduce(s, { type: 'set', path: 'layers.A.in', value: 0.9 });
  assert.ok(s.layers.A.in < s.layers.A.out);
});

test('load: starts the clip, resets loop points, switches overlays on', () => {
  const s = defaultState();
  s.layers.C.in = 0.3;
  const seq = s.layers.C.seq;
  reduce(s, { type: 'load', layer: 'C', src: 'clip1' });
  assert.equal(s.layers.C.src, 'clip1');
  assert.equal(s.layers.C.on, true);
  assert.equal(s.layers.C.in, 0);
  assert.equal(s.layers.C.seq, seq + 1);
  assert.equal(reduce(s, { type: 'load', layer: 'Z', src: 'clip1' }), false);
});

test('cue + go: cued clips all launch on the same action', () => {
  const s = defaultState();
  reduce(s, { type: 'load', layer: 'A', src: 'old' });
  reduce(s, { type: 'load', layer: 'A', src: 'a', cue: true });
  reduce(s, { type: 'load', layer: 'B', src: 'b', cue: true });
  reduce(s, { type: 'load', layer: 'D', src: 'd', cue: true });
  assert.equal(s.layers.A.src, 'old', 'cueing does not change what is playing');
  const seqs = ['A', 'B', 'C', 'D'].map((id) => s.layers[id].seq);
  reduce(s, { type: 'go' });
  assert.deepEqual(['A', 'B', 'D'].map((id) => s.layers[id].src), ['a', 'b', 'd']);
  assert.deepEqual(['A', 'B', 'D'].map((id) => s.layers[id].cue), [null, null, null]);
  assert.equal(s.layers.D.on, true);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((id) => s.layers[id].seq - seqs['ABCD'.indexOf(id)]), [1, 1, 0, 1]);
});

test('eject clears a layer and hides an overlay', () => {
  const s = defaultState();
  reduce(s, { type: 'load', layer: 'C', src: 'x' });
  reduce(s, { type: 'eject', layer: 'C' });
  assert.equal(s.layers.C.src, null);
  assert.equal(s.layers.C.on, false);
});

test('scenes: save, change, recall restores the look', () => {
  const s = defaultState();
  reduce(s, { type: 'load', layer: 'A', src: 'a' });
  reduce(s, { type: 'set', path: 'xfade', value: 0.25 });
  reduce(s, { type: 'set', path: 'fx.kaleido.on', value: true });
  reduce(s, { type: 'scene.save', i: 2 });
  reduce(s, { type: 'load', layer: 'A', src: 'other' });
  reduce(s, { type: 'set', path: 'xfade', value: 1 });
  reduce(s, { type: 'set', path: 'fx.kaleido.on', value: false });
  const seq = s.layers.A.seq;
  assert.ok(reduce(s, { type: 'scene.load', i: 2 }));
  assert.equal(s.layers.A.src, 'a');
  assert.equal(s.xfade, 0.25);
  assert.equal(s.fx.kaleido.on, true);
  assert.equal(s.layers.A.seq, seq + 1, 'changed clip restarts');
  assert.equal(reduce(s, { type: 'scene.load', i: 5 }), false, 'empty slot does nothing');
  assert.equal(reduce(s, { type: 'scene.save', i: 99 }), false);
  // a scene is a copy, not a reference
  const snap = snapshotScene(s);
  snap.layers.A.src = 'mutated';
  assert.equal(s.layers.A.src, 'a');
});

test('fav toggles, tag is trimmed and counted', () => {
  const s = defaultState();
  reduce(s, { type: 'fav', id: 'c1' });
  assert.equal(s.favs.c1, true);
  reduce(s, { type: 'fav', id: 'c1' });
  assert.equal(s.favs.c1, undefined);
  reduce(s, { type: 'tag', text: 'x'.repeat(200), color: '#00ff00' });
  assert.equal(s.tag.text.length, 60);
  assert.equal(s.tag.color, '#00ff00');
  assert.equal(s.tag.n, 1);
  reduce(s, { type: 'tag', text: 'hi', color: 'javascript:alert(1)' });
  assert.equal(s.tag.color, '#00ff00', 'bad colours are ignored');
});

test('hydrate: old or damaged save files fall back to defaults', () => {
  assert.deepEqual(hydrate(null), defaultState());
  const s = hydrate({ xfade: 0.7, layers: { A: { src: 'a', cue: 'zzz' } }, auto: { on: true, chaos: 0.9 }, fx: { trails: { on: true } } });
  assert.equal(s.xfade, 0.7);
  assert.equal(s.layers.A.src, 'a');
  assert.equal(s.layers.A.cue, null);
  assert.equal(s.layers.A.rate, 1, 'missing fields come from defaults');
  assert.equal(s.auto.on, false, 'autopilot never starts by itself after a restart');
  assert.equal(s.auto.chaos, 0.9);
  assert.equal(s.fx.trails.on, true);
  assert.equal(s.fx.trails.amt, defaultState().fx.trails.amt);
});

test('layerVisible follows the crossfader and overlay switches', () => {
  const s = defaultState();
  reduce(s, { type: 'load', layer: 'A', src: 'a' });
  reduce(s, { type: 'load', layer: 'B', src: 'b' });
  assert.equal(layerVisible(s, 'A'), true);
  assert.equal(layerVisible(s, 'B'), false);
  reduce(s, { type: 'set', path: 'xfade', value: 1 });
  assert.equal(layerVisible(s, 'A'), false);
  assert.equal(layerVisible(s, 'B'), true);
  assert.equal(layerVisible(s, 'C'), false);
  reduce(s, { type: 'load', layer: 'C', src: 'c' });
  assert.equal(layerVisible(s, 'C'), true);
});

test('tempo: a tap re-phases the beat without making the beat count jump', () => {
  const s = defaultState();
  s.tempo = { bpm: 120, t0: 0, mic: false };
  // 100.2 beats in, somebody taps slightly late at a faster tempo
  const tapAt = 100.2 * 500;
  reduce(s, { type: 'tempo', bpm: 150, t0: tapAt });
  assert.equal(s.tempo.bpm, 150);
  assert.ok(Math.abs(beatAt(s.tempo, tapAt) - 100) < 1e-9, 'the tap lands exactly on beat 100');
  // changing only the tempo, anchored on a beat, keeps count and phase
  reduce(s, { type: 'tempo', bpm: 75, t0: tapAt });
  assert.ok(Math.abs(beatAt(s.tempo, tapAt) - 100) < 1e-9);
  assert.ok(Math.abs(beatAt(s.tempo, tapAt + 800) - 101) < 1e-9, 'one beat is now 800 ms');
  // out-of-range tempo is ignored
  reduce(s, { type: 'tempo', bpm: 900 });
  assert.equal(s.tempo.bpm, 75);
});

test('beatAt counts beats from t0', () => {
  assert.equal(beatAt({ bpm: 120, t0: 1000 }, 3000), 4);
});
