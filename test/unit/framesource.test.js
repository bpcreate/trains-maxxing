// The stage reads prepared clips itself (public/stage/framesource.js). This
// checks its MP4 reader against a real file written the way proxies are.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { parseMoov } from '../../public/stage/framesource.js';

/** Body of the top-level moov box. */
function moovOf(buf) {
  let o = 0;
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'moov') return buf.subarray(o + 8, o + size);
    if (size < 8) break;
    o += size;
  }
  return null;
}

test('parseMoov: reads the sample table of a prepared-style MP4', { skip: !ffmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-fs-'));
  const file = path.join(dir, 'clip.mp4');
  try {
    const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-frames:v', '12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-g', '2', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', file]);
    assert.equal(r.status, 0, String(r.stderr));
    const buf = fs.readFileSync(file);
    const moov = moovOf(buf);
    assert.ok(moov, 'file has a moov box');
    const info = parseMoov(moov.buffer.slice(moov.byteOffset, moov.byteOffset + moov.length));
    assert.ok(info);
    assert.match(info.codec, /^avc1\.[0-9a-f]{6}$/);
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.equal(info.fps, 30);
    assert.equal(info.samples.length, 12);
    // a keyframe every 2 frames, and every sample lies inside the file
    assert.deepEqual(info.samples.map((s) => s.key), Array.from({ length: 12 }, (_, i) => i % 2 === 0));
    for (const s of info.samples) assert.ok(s.size > 0 && s.off + s.size <= buf.length);
    // samples do not overlap
    const sorted = [...info.samples].sort((a, b) => a.off - b.off);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].off >= sorted[i - 1].off + sorted[i - 1].size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMoov: gives up on something that is not a movie', () => {
  assert.equal(parseMoov(new ArrayBuffer(64)), null);
});
