/** Emits an inline SVG pixel wordmark for TINYDOCK using the 5x7 grid the coin and card share. */

const GLYPHS: Record<string, string[]> = {
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
};

const word = 'TINYDOCK';
const gap = 1;
const letterW = 5;
const rects: string[] = [];

word.split('').forEach((char, li) => {
  const glyph = GLYPHS[char]!;
  const originX = li * (letterW + gap);
  glyph.forEach((row, ry) => {
    [...row].forEach((cell, rx) => {
      if (cell === '#') rects.push(`M${originX + rx} ${ry}h1v1h-1z`);
    });
  });
});

const width = word.length * (letterW + gap) - gap;
const svg = `<svg class="wordmark" viewBox="0 0 ${width} 7" role="img" aria-label="TinyDock"><path d="${rects.join('')}" /></svg>`;
console.log(svg);
