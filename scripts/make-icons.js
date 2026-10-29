'use strict';
// Build the PWA icons with Node zlib. No image dependency.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const px = paint(x, y, size);
      const i = row + 1 + x * 4;
      raw[i] = px[0];
      raw[i + 1] = px[1];
      raw[i + 2] = px[2];
      raw[i + 3] = px[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// A gold kolo on deep green. inset shrinks the pot for the maskable safe zone.
function paintKolo(inset) {
  return (x, y, size) => {
    const cx = (size - 1) / 2;
    const dx = x - cx;
    const dy = y - cx;
    const rx = size * (0.30 - inset);
    const ry = size * (0.32 - inset);
    const py = dy - size * 0.05;
    const inBody = (dx * dx) / (rx * rx) + (py * py) / (ry * ry) <= 1 && dy > -size * (0.18 - inset);
    const rimY = cx - size * (0.20 - inset * 0.4);
    const inRim = Math.abs(y - rimY) <= Math.max(2, size * 0.03) && Math.abs(dx) <= rx * 0.95;
    const knobY = rimY - size * 0.055;
    const inKnob = (dx * dx) + ((y - knobY) * (y - knobY)) <= (size * 0.04) * (size * 0.04);
    const crack = Math.abs(dx - (dy * 0.12)) < Math.max(1.2, size * 0.012) && dy > -size * 0.02 && dy < size * 0.24;
    if (inKnob || inRim) return [255, 217, 122, 255];
    if (inBody && crack) return [122, 74, 8, 255];
    if (inBody) return [232, 169, 12, 255];
    return [20, 61, 48, 255];
  };
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), png(192, paintKolo(0)));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512, paintKolo(0)));
fs.writeFileSync(path.join(dir, 'icon-512-maskable.png'), png(512, paintKolo(0.08)));
fs.writeFileSync(path.join(dir, 'apple-touch-icon.png'), png(180, paintKolo(0)));
console.log('icons written to ' + dir);
