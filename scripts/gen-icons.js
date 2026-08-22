/**
 * Generates the MediStock PWA icons (teal tile + two-tone capsule pill)
 * without any image tooling — raw PNG encoding with Node's zlib.
 *
 *   node scripts/gen-icons.js
 * Writes: client/public/icon-192.png, icon-512.png, icon-maskable-512.png
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- minimal PNG encoder (8-bit RGBA, no filters) -------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- icon drawing (SDF capsule, antialiased) ------------------------------
const TEAL = [0, 105, 92];      // #00695c — MUI primary
const LIGHT = [77, 182, 172];   // #4db6ac — capsule right half
const WHITE = [255, 255, 255];

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(a, b, x) { return clamp01((x - a) / (b - a)); }

/**
 * distance from P to segment AB
 */
function segDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby));
  const dx = px - (ax + t * abx), dy = py - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function drawIcon(size, opts) {
  const { bleed, capsuleScale } = opts; // bleed: rounded-tile corner radius fraction
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;

  // rounded teal tile (full bleed, so any mask shape looks right)
  const r = size * bleed;
  const dTile = (x, y) => {
    const qx = Math.max(Math.abs(x - c) - (c - r), 0);
    const qy = Math.max(Math.abs(y - c) - (c - r), 0);
    return Math.hypot(qx, qy) - r;
  };

  // capsule tilted 45°, halves split by its own axis midpoint
  const d = size * 0.17 * capsuleScale;    // half axis length
  const R = size * 0.13 * capsuleScale;    // capsule radius
  const ax = c - d, ay = c + d, bx = c + d, by = c - d; // from bottom-left to top-right
  const seam = size * 0.008 + 0.5;         // gap between the two halves

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // supersample 2x2 for smooth edges
      let tr = 0, tg = 0, tb = 0, ta = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = x + ox, py = y + oy;
        let col = [0, 0, 0], alpha = 0;
        const tileA = 1 - smooth(-1, 1, dTile(px, py)); // 1 inside tile
        const pillD = segDist(px, py, ax, ay, bx, by);
        const pillA = 1 - smooth(R - 1, R + 1, pillD);
        if (pillA > 0) {
          // which half? project onto axis, and hollow out the seam
          const abx = bx - ax, aby = by - ay;
          const t = ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby);
          const seamD = Math.abs(t - 0.5) * 2 * d; // distance along axis from midpoint
          const seamA = smooth(seam, seam + 1, seamD);
          const base = t < 0.5 ? WHITE : LIGHT;
          col = base;
          alpha = pillA * seamA;
        }
        // composite pill over tile
        const outA = alpha + tileA * (1 - alpha);
        if (outA > 0) {
          tr += (col[0] * alpha + TEAL[0] * tileA * (1 - alpha)) / outA;
          tg += (col[1] * alpha + TEAL[1] * tileA * (1 - alpha)) / outA;
          tb += (col[2] * alpha + TEAL[2] * tileA * (1 - alpha)) / outA;
          ta += outA;
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(tr / 4);
      rgba[i + 1] = Math.round(tg / 4);
      rgba[i + 2] = Math.round(tb / 4);
      rgba[i + 3] = Math.round((ta / 4) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'client', 'public');
fs.mkdirSync(outDir, { recursive: true });

const files = [
  ['icon-192.png', drawIcon(192, { bleed: 0.22, capsuleScale: 1 })],
  ['icon-512.png', drawIcon(512, { bleed: 0.22, capsuleScale: 1 })],
  // maskable: smaller artwork leaves room inside Android's circular crop
  ['icon-maskable-512.png', drawIcon(512, { bleed: 0.5, capsuleScale: 0.85 })],
];
for (const [name, buf] of files) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}
