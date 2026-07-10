import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Draws the social card as raw pixels and encodes a PNG by hand.
 *
 * X and Slack won't render SVG cards, and a rasteriser (sharp, resvg) would pull in a
 * native dependency for one 1200x630 image. A 5x7 bitmap font suits an arcade cabinet
 * better than a scaled webfont would anyway.
 */

const WIDTH = 1200;
const HEIGHT = 630;

const CABINET: RGB = [0x1b, 0x12, 0x20];
const GLOW: RGB = [0x2f, 0x1c, 0x3d];
const MARQUEE: RGB = [0xff, 0xb0, 0x20];
const PHOSPHOR: RGB = [0xff, 0xc4, 0x6b];
const COIN: RGB = [0x3e, 0xd8, 0xc4];
const DIM: RGB = [0x6a, 0x5a, 0x72];

type RGB = [number, number, number];

// 5x7 glyphs. Only the characters the card actually uses.
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);

function setPixel(x: number, y: number, [r, g, b]: RGB, alpha = 1): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  pixels[i] = Math.round((pixels[i] ?? 0) * (1 - alpha) + r * alpha);
  pixels[i + 1] = Math.round((pixels[i + 1] ?? 0) * (1 - alpha) + g * alpha);
  pixels[i + 2] = Math.round((pixels[i + 2] ?? 0) * (1 - alpha) + b * alpha);
  pixels[i + 3] = 255;
}

/** Radial glow from the top centre, the same one the page uses. */
function paintBackground(): void {
  const cx = WIDTH / 2;
  const cy = -HEIGHT * 0.1;
  const radius = WIDTH * 0.72;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      const t = Math.min(1, Math.max(0, d));
      setPixel(x, y, [
        Math.round(GLOW[0] + (CABINET[0] - GLOW[0]) * t),
        Math.round(GLOW[1] + (CABINET[1] - GLOW[1]) * t),
        Math.round(GLOW[2] + (CABINET[2] - GLOW[2]) * t),
      ]);
    }
  }
}

function drawText(text: string, x: number, y: number, scale: number, colour: RGB): number {
  let cursor = x;
  for (const char of text.toUpperCase()) {
    const glyph = GLYPHS[char];
    if (!glyph) {
      cursor += 6 * scale;
      continue;
    }
    glyph.forEach((row, ry) => {
      [...row].forEach((cell, rx) => {
        if (cell !== '#') return;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            setPixel(cursor + rx * scale + dx, y + ry * scale + dy, colour);
          }
        }
      });
    });
    cursor += 6 * scale;
  }
  return cursor;
}

function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

function drawCentred(text: string, y: number, scale: number, colour: RGB): void {
  drawText(text, Math.round((WIDTH - textWidth(text, scale)) / 2), y, scale, colour);
}

function drawCoin(cx: number, cy: number, radius: number): void {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      const d = Math.hypot(x, y);
      if (d > radius) continue;
      const shade = 1 - (d / radius) * 0.45;
      setPixel(cx + x, cy + y, [
        Math.round(COIN[0] * shade),
        Math.round(COIN[1] * shade),
        Math.round(COIN[2] * shade),
      ]);
    }
  }
  // A crude ₮: crossbar, stem, and the second stroke that makes it tether rather than tee.
  const s = Math.round(radius / 8);
  for (let x = -3 * s; x <= 3 * s; x++) for (let t = 0; t < s; t++) setPixel(cx + x, cy - 3 * s + t, CABINET);
  for (let y = -3 * s; y <= 4 * s; y++) for (let t = 0; t < s; t++) setPixel(cx + t, cy + y, CABINET);
  for (let x = -2 * s; x <= 2 * s; x++) for (let t = 0; t < s; t++) setPixel(cx + x, cy - s + t, CABINET);
}

function drawScanlines(): void {
  for (let y = 0; y < HEIGHT; y += 3) {
    for (let x = 0; x < WIDTH; x++) setPixel(x, y, [0, 0, 0], 0.22);
  }
}

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(HEIGHT * (WIDTH * 4 + 1));
  for (let y = 0; y < HEIGHT; y++) {
    const at = y * (WIDTH * 4 + 1);
    raw[at] = 0;
    pixels.copy(raw, at + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

paintBackground();
drawCentred('TINYDOCK', 150, 14, MARQUEE);
drawCentred('NO ACCOUNT. NO CARD. NO HUMAN.', 300, 5, PHOSPHOR);
drawCoin(WIDTH / 2, 430, 52);
drawCentred('RUN OR HOST. 0.01 USDT0', 530, 4, DIM);
drawScanlines();

const out = fileURLToPath(new URL('../public/og.png', import.meta.url));
writeFileSync(out, encodePng());
console.log(`wrote ${out}`);
