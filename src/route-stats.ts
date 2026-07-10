import type { IncomingMessage, ServerResponse } from 'node:http';
import { PRICE } from './config.js';
import { stats } from './feed.js';
import { usageSnapshot } from './guards.js';
import { PRESETS } from './presets.js';
import { storeIsShared } from './store.js';

export default async function handler(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const [feed, { inFlight, paidUsedRatio, demoExhausted }] = await Promise.all([
    stats(),
    usageSnapshot(),
  ]);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ...feed,
      priceUsd: PRICE,
      inFlight,
      outOfOrder: paidUsedRatio >= 1,
      demoExhausted,
      // False means these counters are this instance's alone. The page says so.
      durable: storeIsShared(),
      presets: PRESETS.map(({ id, label, language }) => ({ id, label, language })),
    }),
  );
}
