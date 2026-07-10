import { execute, type ExecuteRequest } from '../src/execute.js';

const cases: Array<{ name: string; req: ExecuteRequest }> = [
  {
    name: 'python: arithmetic',
    req: { language: 'python', source: 'print(sum(range(10)))' },
  },
  {
    name: 'node: stdout',
    req: { language: 'node', source: 'console.log("hello from node " + process.version)' },
  },
  {
    name: 'python: egress must be blocked',
    req: {
      language: 'python',
      source: [
        'import urllib.request',
        'try:',
        '    urllib.request.urlopen("https://example.com", timeout=3).read()',
        '    print("LEAK: network reachable")',
        'except Exception as e:',
        '    print("blocked:", type(e).__name__)',
      ].join('\n'),
    },
  },
  {
    name: 'python: infinite loop must time out',
    req: { language: 'python', source: 'while True:\n    pass', timeoutMs: 2000 },
  },
  {
    name: 'python: nonzero exit',
    req: { language: 'python', source: 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)' },
  },
];

for (const { name, req } of cases) {
  console.log(`\n─── ${name}`);
  try {
    const r = await execute(req);
    console.log({
      stdout: r.stdout.trim(),
      stderr: r.stderr.trim().slice(0, 120),
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    });
  } catch (err) {
    console.log('THREW:', String(err));
  }
}
