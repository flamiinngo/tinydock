import { Sandbox } from '@vercel/sandbox';

/**
 * Spike: can a sandbox serve a public URL while its outbound network is dead?
 *
 * TinyDock's whole security story is that untrusted code has no egress. Selling an agent a
 * live URL means inbound traffic. If `deny-all` also kills the inbound route, then hosting
 * and isolation are mutually exclusive here and the product idea dies on this script.
 *
 * Three questions, in order:
 *   1. Does `ports` + `deny-all` boot at all?
 *   2. Does the public domain answer from outside?
 *   3. Is egress still dead from inside, i.e. did we keep the isolation we sell?
 *
 *   node --env-file=.env.local --import tsx scripts/spike-serve.ts
 */

const PORT = 3000;
const LEASE_MS = 90_000;

/** Serves one page and, on /egress, reports whether it can reach the internet. */
const SERVER = `
const http = require('node:http');
http.createServer(async (req, res) => {
  if (req.url === '/egress') {
    try {
      await fetch('https://example.com', { signal: AbortSignal.timeout(3000) });
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ egress: 'REACHABLE — isolation is broken' }));
    } catch (err) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ egress: 'blocked', error: String(err.name ?? err) }));
    }
    return;
  }
  res.writeHead(200, {'Content-Type':'text/html'});
  res.end('<h1>Served from a sandbox an agent paid for</h1>');
}).listen(${PORT}, () => console.log('listening'));
`;

const step = (n: number, text: string): void => console.log(`\n[${n}] ${text}`);

let sandbox: Sandbox | undefined;
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  step(1, 'create sandbox with an exposed port AND deny-all egress');
  const startedAt = Date.now();
  sandbox = await Sandbox.create({
    runtime: 'node24',
    ports: [PORT],
    networkPolicy: 'deny-all',
    timeout: LEASE_MS,
    resources: { vcpus: 1 },
  });
  check('booted', true, `${Date.now() - startedAt}ms`);

  step(2, 'resolve the public domain');
  const url = sandbox.domain(PORT);
  console.log(`  url: ${url}`);
  check('domain returned', typeof url === 'string' && url.startsWith('https://'));

  step(3, 'start the server detached');
  await sandbox.writeFiles([{ path: 'server.js', content: Buffer.from(SERVER, 'utf8') }]);
  await sandbox.runCommand({ cmd: 'node', args: ['server.js'], detached: true });

  // The route needs a moment to come up after the listener binds.
  for (let i = 0; i < 15; i++) {
    try {
      const probe = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (probe.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  step(4, 'fetch the public URL from the open internet');
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const html = await res.text();
  check('inbound HTTP works', res.ok, `HTTP ${res.status}`);
  check('served our HTML', html.includes('paid for'), html.slice(0, 60));

  step(5, 'the load-bearing one: is egress still dead from inside?');
  const egress = await fetch(`${url}/egress`, { signal: AbortSignal.timeout(10000) });
  const verdict = (await egress.json()) as { egress: string; error?: string };
  console.log(`  ${JSON.stringify(verdict)}`);
  check('outbound still blocked', verdict.egress === 'blocked', verdict.error ?? '');
} catch (err) {
  console.error('\nspike failed:', err instanceof Error ? err.message : String(err));
  failures += 1;
} finally {
  await sandbox?.stop().catch(() => {});
}

console.log(
  failures === 0
    ? '\nVERDICT: a sandbox can serve a public URL with egress denied. The product is possible.'
    : `\nVERDICT: ${failures} check(s) failed. See above.`,
);
process.exit(failures === 0 ? 0 : 1);
