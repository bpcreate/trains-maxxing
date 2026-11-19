// Self-signed HTTPS certificate. Safari only allows camera access on HTTPS,
// so the iPad kaleidoscope page is served through this.

import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';

export function loadOrCreateCert(dataDir, ips) {
  const file = path.join(dataDir, 'cert.json');
  const wanted = [...ips].sort().join(',');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // reuse the certificate while the laptop's addresses are unchanged, so the
    // iPad does not have to accept the warning again
    if (saved.ips === wanted && saved.expires > Date.now() + 7 * 864e5) return saved;
  } catch { /* none yet */ }

  const days = 800;
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Trains Maxxing' }], {
    days,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  const cert = { key: pems.private, cert: pems.cert, ips: wanted, expires: Date.now() + days * 864e5 };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cert));
  return cert;
}
