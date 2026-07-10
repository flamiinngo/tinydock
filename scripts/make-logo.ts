import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * The TinyDock mark: an arcade token you press play on.
 *
 * A teal coin with a reeded edge and an amber play triangle — coin-operated compute
 * in one glyph. Rendered as a 1024² PNG for the OKX avatar (needs a real 1:1 file)
 * and, separately, as an inline SVG the page can scale crisply.
 */

const SIZE = 1024;
type RGB = [number, number, number];

const CABINET: RGB = [0x1b, 0x12, 0x20];
const PANEL: RGB = [0x2a, 0x1b, 0x33];
const COIN: RGB = [0x3e, 0xd8, 0xc4];
const COIN_LIGHT: RGB = [0x7f, 0xf0, 0xe2];
const COIN_DARK: RGB = [0x1c, 0x8f, 0x83];
const MARQUEE: RGB = [0xff, 0xb0, 0x20];

const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x: number, y: number, [r, g, b]: RGB, a = 1): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = Math.round((px[i] ?? 0) * (1 - a) + r * a);
  px[i + 1] = Math.round((px[i + 1] ?? 0) * (1 - a) + g * a);
  px[i + 2] = Math.round((px[i + 2] ?? 0) * (1 - a) + b * a);
  px[i + 3] = 255;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const cx = SIZE / 2;
const cy = SIZE / 2;

// Rounded-square cabinet ground so the avatar reads as a tile, not a floating disc.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    set(x, y, mix(PANEL, CABINET, Math.hypot(x - cx, y - cy) / (SIZE * 0.75)));
  }
}

const outer = SIZE * 0.4;
const rim = SIZE * 0.345;
const face = SIZE * 0.33;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d > outer) continue;

    if (d > rim) {
      // Reeded edge: alternating light/dark notches around the coin.
      const notch = Math.floor((Math.atan2(dy, dx) + Math.PI) / (Math.PI / 36)) % 2;
      set(x, y, notch ? COIN_DARK : mix(COIN, COIN_DARK, 0.4));
      continue;
    }
    if (d > face) {
      set(x, y, COIN_DARK); // inner bevel
      continue;
    }
    // Coin face: top-left light, bottom-right dark, for a struck-metal read.
    const shade = 0.5 - (dx + dy) / (face * 4);
    set(x, y, mix(COIN, dx + dy < 0 ? COIN_LIGHT : COIN_DARK, Math.min(0.6, Math.abs(shade))));
  }
}

// Amber play triangle, punched into the coin face.
const triH = SIZE * 0.28;
const triW = SIZE * 0.24;
const tipX = cx + triW * 0.55;
const backX = cx - triW * 0.45;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (x < backX || x > tipX) continue;
    const progress = (x - backX) / (tipX - backX);
    const halfH = (triH / 2) * (1 - progress);
    if (Math.abs(y - cy) <= halfH) {
      const edge = halfH - Math.abs(y - cy);
      set(x, y, MARQUEE, edge < 6 ? 0.5 : 1); // soft-ish edge
    }
  }
}

// CRT scanline sweep across the whole face — the retro-screen nod.
for (let y = 0; y < SIZE; y += 4) {
  for (let x = 0; x < SIZE; x++) {
    if (Math.hypot(x - cx, y - cy) <= rim) set(x, y, [0, 0, 0], 0.12);
  }
}

// ── PNG encode (RGBA, filter 0) ─────────────────────────────────────────────
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const at = y * (SIZE * 4 + 1);
  raw[at] = 0;
  px.copy(raw, at + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = fileURLToPath(new URL('../public/logo.png', import.meta.url));
writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(0)} KB)`);
