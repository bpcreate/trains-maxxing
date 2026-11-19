// Trains Maxxing server. Run it on the laptop that drives the projector:
//   npm start
// then open the stage page on the laptop and scan the QR code with a phone.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { APP_NAME } from '../shared/state.js';
import { loadOrCreateCert } from './cert.js';
import { Hub } from './hub.js';
import { Media } from './media.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.TM_PORT || 8080);
const HTTPS_PORT = +(process.env.TM_HTTPS_PORT || 8443);
const MEDIA_DIR = path.resolve(process.env.TM_MEDIA || path.join(ROOT, 'media'));
const DATA_DIR = path.resolve(process.env.TM_DATA || path.join(ROOT, 'data'));
const CACHE_DIR = path.join(DATA_DIR, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---- network addresses ----

function lanIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  // home / hotspot ranges first
  const score = (ip) => (/^192\.168\./.test(ip) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : /^10\./.test(ip) ? 2 : 3);
  return ips.sort((a, b) => score(a) - score(b));
}

const isLoopback = (req) => {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
};

// ---- session token: keeps strangers on the same Wi-Fi off the controls ----

function loadToken() {
  if (process.env.TM_TOKEN) return process.env.TM_TOKEN;
  const file = path.join(DATA_DIR, 'token.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 6) return t;
  } catch { /* first run */ }
  const t = randomBytes(5).toString('hex');
  fs.writeFileSync(file, t);
  return t;
}
const TOKEN = loadToken();
const tokenOk = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

function urls() {
  const ip = lanIps()[0] || 'localhost';
  return {
    stage: `http://localhost:${PORT}/stage/`,
    remote: `http://${ip}:${PORT}/remote/?k=${TOKEN}`,
    kaleido: `https://${ip}:${HTTPS_PORT}/kaleido/?k=${TOKEN}`,
  };
}

// ---- app ----

const media = new Media({
  mediaDir: MEDIA_DIR,
  cacheDir: CACHE_DIR,
  proxyFormat: process.env.TM_PROXY === 'webm' ? 'webm' : 'mp4',
  onChange: () => hub?.clipsChanged(),
});
let hub = null;

const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => {
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(isLoopback(req) ? '/stage/' : `/remote/${q}`);
});

// QR codes and links: only for the laptop itself or someone who already has the token
app.get('/api/qr/:kind.svg', async (req, res) => {
  if (!isLoopback(req) && !tokenOk(req.query.k)) return res.status(403).end();
  const u = urls()[req.params.kind];
  if (!u || req.params.kind === 'stage') return res.status(404).end();
  const svg = await QRCode.toString(u, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});
app.get('/api/info', (req, res) => {
  if (!isLoopback(req) && !tokenOk(req.query.k)) return res.status(403).end();
  res.set('Cache-Control', 'no-store').json({ name: APP_NAME, urls: urls() });
});

app.get('/media/:id', (req, res) => {
  const file = media.filePath(req.params.id);
  if (!file) return res.status(404).end();
  res.sendFile(file, { acceptRanges: true });
});
app.use('/cache', express.static(CACHE_DIR, { maxAge: '1h', index: false }));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/fonts', express.static(path.join(ROOT, 'node_modules/@fontsource/sedgwick-ave-display/files'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---- servers ----

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== '/ws' || (!isLoopback(req) && !tokenOk(u.searchParams.get('k')))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => hub.connect(ws, u.searchParams.get('role')));
}

async function main() {
  await media.start();
  hub = new Hub({ media, dataDir: DATA_DIR, info: { httpsPort: HTTPS_PORT, port: PORT } });

  const httpServer = http.createServer(app);
  httpServer.on('upgrade', onUpgrade);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, resolve);
  });

  let httpsOk = false;
  try {
    const cert = loadOrCreateCert(DATA_DIR, lanIps());
    const httpsServer = https.createServer({ key: cert.key, cert: cert.cert }, app);
    httpsServer.on('upgrade', onUpgrade);
    await new Promise((resolve, reject) => {
      httpsServer.once('error', reject);
      httpsServer.listen(HTTPS_PORT, resolve);
    });
    httpsOk = true;
  } catch (e) {
    console.warn(`HTTPS could not start (${e.message}); the iPad kaleidoscope needs it for camera access.`);
  }

  const u = urls();
  console.log(`\n  ${APP_NAME} is running\n`);
  console.log(`  Big screen (open on this laptop):  ${u.stage}`);
  console.log(`  Phone remote:                      ${u.remote}`);
  if (httpsOk) console.log(`  iPad kaleidoscope:                 ${u.kaleido}`);
  console.log(`\n  Videos folder: ${MEDIA_DIR}  (${media.list().length} clips)`);
  if (!media.ffmpeg) console.log('  ! ffmpeg was not found: no thumbnails, and no smooth scrubbing/reverse.');
  if (!lanIps().length) console.log('  ! No network found: connect the laptop to Wi-Fi or a phone hotspot.');
  console.log('\n  Scan this with the phone (same Wi-Fi as the laptop):\n');
  console.log(await QRCode.toString(u.remote, { type: 'terminal', small: true }));

  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', u.stage] : [u.stage];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch { /* no browser to open */ }
  }
}

main().catch((e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. ${APP_NAME} is probably already running; close the other window first.\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
