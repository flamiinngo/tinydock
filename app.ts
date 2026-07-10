import { readFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import mcp from './src/route-mcp.js';
import play from './src/route-play.js';
import stats from './src/route-stats.js';

/**
 * One HTTP server rather than per-route serverless functions, so the feed and the
 * abuse guards can share process memory.
 *
 * That memory is not durable. On Vercel this runs as a Function: instances are reused
 * but recycled freely, and several may be warm at once. The feed's counters reset when
 * an instance dies, and `guards.ts` enforces its budget per instance, so a busy fleet
 * can overshoot a ceiling each instance individually respects. Settled payments are
 * never lost — those are on chain — but the numbers this process reports about them
 * are best-effort. A shared counter (Upstash) is the fix.
 */

const port = Number(process.env.PORT ?? 3000);
const indexPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const ogPath = fileURLToPath(new URL('./public/og.png', import.meta.url));

let cachedIndex: Buffer | undefined;
let cachedOg: Buffer | undefined;

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];

  if (path === '/api/mcp') return mcp(req, res);
  if (path === '/api/stats') return stats(req, res);
  if (path === '/api/play') return play(req, res);

  if (path === '/og.png') {
    cachedOg ??= await readFile(ogPath);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(cachedOg);
    return;
  }

  if (path === '/' || path === '/index.html') {
    cachedIndex ??= await readFile(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(cachedIndex);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

createServer((req, res) => {
  void route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
}).listen(port, () => console.log(`tinydock listening on :${port}`));
