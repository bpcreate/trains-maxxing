import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe } from '../../server/media.js';
import { TapTempo } from '../../server/clock.js';

test('parseProbe: landscape H.264 with audio', () => {
  const m = parseProbe(`Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 8123 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 7990 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`);
  assert.deepEqual(m, { dur: 62.5, w: 1920, h: 1080, fps: 29.97, audio: true, hdr: false });
});

test('parseProbe: phone portrait stored sideways (rotation side data)', () => {
  const m = parseProbe(`  Duration: 00:00:12.03, start: 0.000000, bitrate: 15000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 14800 kb/s, 30 fps, 30 tbr, 600 tbn (default)
    Metadata:
      handler_name    : Core Media Video
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 180 kb/s (default)`);
  assert.equal(m.w, 1080);
  assert.equal(m.h, 1920);
  assert.equal(m.dur, 12.03);
});

test('parseProbe: old-style rotate tag, no audio', () => {
  const m = parseProbe(`  Duration: 00:00:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0(eng): Video: h264 (Baseline) (avc1 / 0x31637661), yuv420p, 1280x720, 890 kb/s, 30 fps, 30 tbr, 90k tbn (default)
    Metadata:
      rotate          : 90`);
  assert.equal(m.w, 720);
  assert.equal(m.h, 1280);
  assert.equal(m.audio, false);
});

test('parseProbe: rotation on the audio stream does not turn the video', () => {
  const m = parseProbe(`  Duration: 00:00:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: vp8, yuv420p(progressive), 1280x720, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn (default)
  Stream #0:1: Audio: vorbis, 44100 Hz, stereo
    Metadata:
      rotate          : 90`);
  assert.equal(m.w, 1280);
  assert.equal(m.h, 720);
});

test('parseProbe: cover art is not mistaken for the video, junk gives zeros', () => {
  const m = parseProbe(`  Duration: 00:00:08.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Video: mjpeg, yuvj420p, 600x600, 90k tbr (attached pic)
  Stream #0:1: Video: h264, yuv420p, 640x360, 25 fps`);
  assert.equal(m.w, 640);
  assert.deepEqual(parseProbe('a.txt: Invalid data found when processing input'), { dur: 0, w: 0, h: 0, fps: 0, audio: false, hdr: false });
});

test('parseProbe: iPhone HLG HEVC is flagged HDR, portrait turned', () => {
  const m = parseProbe(`  Duration: 00:00:21.03, start: 0.000000, bitrate: 9100 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 1920x1080, 8426 kb/s, 30 fps, 30 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees`);
  assert.equal(m.hdr, true);
  assert.equal(m.w, 1080);
  assert.equal(m.h, 1920);
});

test('TapTempo: steady taps give the BPM, a long pause starts over', () => {
  const t = new TapTempo();
  assert.deepEqual(t.tap(1000), { t0: 1000 });
  t.tap(1500);
  t.tap(2000);
  const r = t.tap(2500);
  assert.equal(r.bpm, 120);
  assert.equal(r.t0, 2500);
  assert.deepEqual(t.tap(9000), { t0: 9000 }, 'after a pause the first tap only re-phases');
  assert.equal(t.tap(9400).bpm, 150);
});
