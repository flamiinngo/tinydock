import type { IncomingMessage, ServerResponse } from 'node:http';
import { PRICE } from './config.js';
import { stats } from './feed.js';
import { usageSnapshot } from './guards.js';
import { PRESETS } from './presets.js';

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  const { inFlight, paidUsedRatio, demoExhausted } = usageSnapshot();

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ...stats(),
      priceUsd: PRICE,
      inFlight,
      outOfOrder: paidUsedRatio >= 1,
      demoExhausted,
      presets: PRESETS.map(({ id, label, language }) => ({ id, label, language })),
    }),
  );
}
