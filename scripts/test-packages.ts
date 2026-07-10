import { ExecuteError, execute } from '../src/execute.js';

async function attempt(name: string, run: () => Promise<unknown>): Promise<void> {
  console.log(`\n─── ${name}`);
  try {
    console.log(await run());
  } catch (err) {
    console.log(
      err instanceof ExecuteError ? `ExecuteError[${err.code}]: ${err.message}` : `THREW: ${err}`,
    );
  }
}

const brief = (r: Awaited<ReturnType<typeof execute>>) => ({
  stdout: r.stdout.trim(),
  stderr: r.stderr.trim().slice(0, 160),
  exitCode: r.exitCode,
  spawnMs: r.spawnMs,
  runMs: r.runMs,
});

// A package the stdlib does not have.
await attempt('python: install cowsay and use it', async () =>
  brief(
    await execute({
      language: 'python',
      packages: ['cowsay'],
      source: 'import cowsay\ncowsay.cow("paid 0.01 USDT0")',
    }),
  ),
);

// The load-bearing test: the package installed, so the network was up — and by the time
// the caller's own code runs it must be gone.
await attempt('python: installed package, but egress still dead at runtime', async () =>
  brief(
    await execute({
      language: 'python',
      packages: ['requests'],
      source: [
        'import requests',
        'print("requests imported:", requests.__version__)',
        'try:',
        '    requests.get("https://example.com", timeout=3)',
        '    print("LEAK: network reachable after install")',
        'except Exception as e:',
        '    print("egress blocked at runtime:", type(e).__name__)',
      ].join('\n'),
      timeoutMs: 5000,
    }),
  ),
);

await attempt('node: install left-pad', async () =>
  brief(
    await execute({
      language: 'node',
      packages: ['left-pad'],
      source: 'console.log(require("left-pad")("42", 8, "0"))',
    }),
  ),
);

// Argument injection: a leading dash would be read by pip as a flag.
await attempt('reject flag-shaped package', async () =>
  execute({ language: 'python', packages: ['--index-url=http://evil.test'], source: 'pass' }),
);

// Remote install: a URL would fetch arbitrary code with the network still up.
await attempt('reject url package', async () =>
  execute({ language: 'python', packages: ['git+https://evil.test/x.git'], source: 'pass' }),
);

await attempt('reject too many packages', async () =>
  execute({ language: 'python', packages: ['a', 'b', 'c', 'd', 'e', 'f'], source: 'pass' }),
);

// No packages requested: the sandbox must be born with deny-all, not merely switched to it.
await attempt('no packages: still no network', async () =>
  brief(
    await execute({
      language: 'python',
      source: 'import urllib.request\ntry:\n    urllib.request.urlopen("https://example.com", timeout=2)\n    print("LEAK")\nexcept Exception as e:\n    print("blocked:", type(e).__name__)',
    }),
  ),
);
