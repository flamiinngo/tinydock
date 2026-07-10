import type { Language } from './execute.js';

/**
 * The public cabinet runs these and nothing else.
 *
 * Accepting arbitrary source from an unauthenticated web page would be a free,
 * anonymous code-execution service — the exact abuse the paywall exists to prevent.
 * Visitors pick a preset by name; the source never crosses the wire.
 */
export interface Preset {
  id: string;
  label: string;
  language: Language;
  source: string;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'fib',
    label: 'FIBONACCI',
    language: 'python',
    source: 'a, b = 0, 1\nfor _ in range(90):\n    a, b = b, a + b\nprint(f"fib(90) = {a}")',
  },
  {
    id: 'primes',
    label: 'PRIME SIEVE',
    language: 'python',
    source: [
      'n = 200000',
      'sieve = bytearray([1]) * n',
      'sieve[0:2] = b"\\x00\\x00"',
      'for i in range(2, int(n ** 0.5) + 1):',
      '    if sieve[i]:',
      '        sieve[i*i::i] = bytearray(len(sieve[i*i::i]))',
      'print(f"{sum(sieve)} primes below {n}")',
    ].join('\n'),
  },
  {
    id: 'escape',
    label: 'TRY TO ESCAPE',
    language: 'python',
    source: [
      'import urllib.request',
      'try:',
      '    urllib.request.urlopen("https://example.com", timeout=2)',
      '    print("NETWORK REACHED - this should never print")',
      'except Exception as e:',
      '    print(f"egress blocked: {type(e).__name__}")',
    ].join('\n'),
  },
] as const;

export function findPreset(id: unknown): Preset | undefined {
  return typeof id === 'string' ? PRESETS.find((p) => p.id === id) : undefined;
}
