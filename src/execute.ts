import { Sandbox } from '@vercel/sandbox';

export type Language = 'node' | 'python';

export interface ExecuteRequest {
  language: Language;
  source: string;
  timeoutMs?: number;
  /** Registry packages to install before the network is switched off. */
  packages?: string[];
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** Booting the microVM and uploading the source. Ours to pay, not the program's. */
  spawnMs: number;
  /** How long the program itself ran. This is the number a caller cares about. */
  runMs: number;
  /**
   * Wall clock for the whole call. Overstates the active CPU Vercel actually bills,
   * which suits a budget guard. Reading true CPU means `stop({ blocking: true })`,
   * which costs ~3.7s of latency per call.
   */
  durationMs: number;
}

export class ExecuteError extends Error {
  constructor(
    readonly code:
      | 'source_too_large'
      | 'unsupported_language'
      | 'sandbox_failed'
      | 'invalid_package'
      | 'install_failed'
      | 'never_listened',
    message: string,
  ) {
    super(message);
    this.name = 'ExecuteError';
  }
}

/**
 * Did this failure happen after a microVM booted, and therefore cost us sandbox time?
 *
 * The four codes below are all raised before `Sandbox.create()` returns, so they are free.
 * Anything else — a failed install, a transport error mid-run — means a VM was running and
 * the budget guard must be told, or a caller who reliably triggers it runs the machine for
 * nothing. An unrecognised error is assumed to have cost us; undercounting is the worse bug.
 */
export function burnedSandboxTime(err: unknown): boolean {
  if (!(err instanceof ExecuteError)) return true;
  return !(
    err.code === 'source_too_large' ||
    err.code === 'unsupported_language' ||
    err.code === 'invalid_package' ||
    err.code === 'sandbox_failed'
  );
}

export const MAX_SOURCE_BYTES = 256 * 1024;
export const MAX_TIMEOUT_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_OUTPUT_CHARS = 64 * 1024;

/** Headroom so the VM outlives the command and can report its own shutdown stats. */
const SESSION_GRACE_MS = 10_000;

/**
 * One vCPU, which carries 2 GB rather than the default 2 vCPU / 4 GB.
 *
 * Provisioned memory dominates the cost of a call: Vercel bills a one-minute minimum per
 * `Sandbox.create()` however briefly the program runs, so halving the memory halves the
 * floor — $0.00141 to $0.00071 a call. A single untrusted script capped at 5s does not
 * use a second core, and the cases that would (a parallel build) are not what this sells.
 */
const VCPUS = 1;

const RUNTIMES: Record<Language, 'node24' | 'python3.13'> = {
  node: 'node24',
  python: 'python3.13',
};

const ENTRYPOINTS: Record<Language, { file: string; cmd: string; args: string[] }> = {
  node: { file: 'main.js', cmd: 'node', args: ['main.js'] },
  python: { file: 'main.py', cmd: 'python3', args: ['main.py'] },
};

const SERVERS: Record<Language, { file: string; cmd: string; args: string[] }> = {
  node: { file: 'server.js', cmd: 'node', args: ['server.js'] },
  python: { file: 'server.py', cmd: 'python3', args: ['server.py'] },
};

/** The only port we route. Injected as $PORT so the caller need not hardcode it. */
export const SERVE_PORT = 3000;

export const DEFAULT_LEASE_SECONDS = 120;

/**
 * Leases are short on purpose, and the reason is not cost.
 *
 * An anonymous, crypto-paid, public URL serving arbitrary HTML is a phishing kit hosted on
 * our Vercel account under their acceptable-use policy. Five minutes is long enough to
 * demo a frontend and too short to be worth pointing a campaign at. The other half of the
 * answer is `guards.admitLease`, which limits leases per paying wallet — an identity a
 * caller cannot fake, because it signed the money.
 *
 * At 5 minutes a lease costs ~$0.0035 of provisioned memory against a cent collected.
 */
export const MAX_LEASE_SECONDS = 300;

/** How long we wait for the caller's server to bind before calling the lease a failure. */
const LISTEN_TIMEOUT_MS = 12_000;

export interface ServeRequest {
  language: Language;
  source: string;
  packages?: string[];
  leaseSeconds?: number;
}

export interface ServeResult {
  url: string;
  sandboxId: string;
  expiresAt: number;
  leaseSeconds: number;
  /** Boot, install, and time spent waiting for the port to answer. Ours, not the caller's. */
  bootMs: number;
}

export const MAX_PACKAGES = 3;

/**
 * Registry traffic bills at $0.15/GB and nothing in the SDK lets us cap bytes mid-install,
 * so the install window is the only lever we have. 25s keeps a plausible worst case under
 * the price of a call, and — with a 5s run and 10s of grace — holds the whole session to
 * 40s, inside the single one-minute increment Vercel bills provisioned memory in. At 45s
 * the session touched 60s exactly and risked paying for two.
 *
 * This bounds egress by time, not by bytes. A caller on a fast link can still cost more
 * than they pay. Metering the sandbox's own `totalEgressBytes` needs a blocking stop
 * (~3.7s per call), which is the wrong trade until abuse is observed.
 */
export const INSTALL_TIMEOUT_MS = 25_000;

/**
 * Names only. A leading `-` would be read as a flag, and a `/`, `:` or `@git+` would
 * let a caller install from an arbitrary URL — both turn `packages` into arbitrary
 * command execution with the network still up.
 */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Least privilege even during install: the registry and its CDN, nothing else.
 *
 * Neither installer is allowed to execute package-authored code. `npm install` would run
 * `postinstall`, and `pip` would run `setup.py` to build a source distribution — both while
 * the registry network is still reachable and before the source under test has even landed.
 * The VM is a throwaway, so this is not a containment hole, but it is someone else's code
 * spending our CPU and our egress. `--ignore-scripts` and `--only-binary` say no.
 */
const INSTALLERS: Record<
  Language,
  { cmd: string; args: (packages: string[]) => string[]; allow: string[] }
> = {
  python: {
    cmd: 'python3',
    args: (packages) => [
      '-m',
      'pip',
      'install',
      '--no-input',
      '--disable-pip-version-check',
      '--quiet',
      // Wheels only: an sdist would execute setup.py during install.
      '--only-binary=:all:',
      '--no-cache-dir',
      ...packages,
    ],
    allow: ['pypi.org', 'files.pythonhosted.org'],
  },
  node: {
    cmd: 'npm',
    args: (packages) => [
      'install',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '--ignore-scripts',
      '--omit=dev',
      ...packages,
    ],
    allow: ['registry.npmjs.org'],
  },
};

function validatePackages(packages: string[]): void {
  if (packages.length > MAX_PACKAGES) {
    throw new ExecuteError('invalid_package', `At most ${MAX_PACKAGES} packages per call.`);
  }
  for (const name of packages) {
    if (!PACKAGE_NAME.test(name)) {
      throw new ExecuteError(
        'invalid_package',
        `"${name}" is not a plain package name. Versions, URLs, paths and flags are rejected.`,
      );
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…output truncated`
    : text;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Runs untrusted source in a throwaway Firecracker microVM with egress disabled.
 *
 * When `packages` are requested the sandbox opens with a registry-only allowlist,
 * installs, and is switched to `deny-all` *before the source is ever written to disk*.
 * Untrusted code therefore never coexists with a network, and the ordering below is
 * load-bearing rather than incidental.
 */
export async function execute(req: ExecuteRequest): Promise<ExecuteResult> {
  const entry = ENTRYPOINTS[req.language];
  if (!entry) {
    throw new ExecuteError('unsupported_language', `Unsupported language: ${req.language}`);
  }

  const sourceBytes = Buffer.byteLength(req.source, 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw new ExecuteError(
      'source_too_large',
      `Source is ${sourceBytes} bytes; limit is ${MAX_SOURCE_BYTES}.`,
    );
  }

  const packages = req.packages ?? [];
  if (packages.length > 0) validatePackages(packages);

  const timeoutMs = clamp(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  const installer = INSTALLERS[req.language];
  const sessionMs =
    timeoutMs + SESSION_GRACE_MS + (packages.length > 0 ? INSTALL_TIMEOUT_MS : 0);
  const startedAt = Date.now();

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIMES[req.language],
      networkPolicy: packages.length > 0 ? { allow: installer.allow } : 'deny-all',
      timeout: sessionMs,
      resources: { vcpus: VCPUS },
    });
  } catch (err) {
    throw new ExecuteError('sandbox_failed', `Could not create sandbox: ${String(err)}`);
  }

  let stdout = '';
  let stderr = '';
  let exitCode = -1;
  let timedOut = false;
  let spawnMs = 0;
  let runMs = 0;

  try {
    if (packages.length > 0) {
      let installed;
      try {
        installed = await sandbox.runCommand({
          cmd: installer.cmd,
          args: installer.args(packages),
          signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        });
      } catch (err) {
        if (!isAbort(err)) throw err;
        throw new ExecuteError(
          'install_failed',
          `Installing ${packages.join(', ')} exceeded ${INSTALL_TIMEOUT_MS / 1000}s.`,
        );
      }
      if (installed.exitCode !== 0) {
        const why = (await installed.stderr()).trim().slice(0, 400);
        throw new ExecuteError('install_failed', why || `Could not install ${packages.join(', ')}.`);
      }
      // Nothing untrusted has touched this VM yet. Cut the network before it does.
      await sandbox.updateNetworkPolicy('deny-all');
    }

    await sandbox.writeFiles([{ path: entry.file, content: Buffer.from(req.source, 'utf8') }]);
    spawnMs = Date.now() - startedAt;

    const runStartedAt = Date.now();
    try {
      const finished = await sandbox.runCommand({
        cmd: entry.cmd,
        args: entry.args,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Stop the clock here: fetching stdout is a round trip the program didn't spend.
      runMs = Date.now() - runStartedAt;
      exitCode = finished.exitCode;
      [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    } catch (err) {
      runMs = Date.now() - runStartedAt;
      if (!isAbort(err)) throw err;
      timedOut = true;
      stderr = `Execution exceeded ${timeoutMs}ms and was terminated.`;
    }
  } finally {
    // Not awaited: stopping costs ~1.6s and the sandbox's own `timeout` guarantees
    // teardown even if this request dies first.
    void sandbox.stop().catch(() => {});
  }

  return {
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    exitCode,
    timedOut,
    spawnMs,
    runMs,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Leases a public URL backed by a throwaway microVM, then walks away.
 *
 * The sandbox is *not* stopped here — that is the product. Its own `timeout` terminates it
 * when the lease expires, so a crashed request cannot leave a VM running forever.
 *
 * Egress stays denied while inbound routing works, which is the property that makes this
 * sellable: the leased box can answer visitors and reach nothing. It cannot proxy, cannot
 * exfiltrate, cannot be used as a relay. Verified in `scripts/spike-serve.ts`.
 *
 * The install-then-cut-network ordering below is the same load-bearing sequence `execute`
 * uses, and for the same reason: the caller's source never lands while a network exists.
 */
export async function serve(req: ServeRequest): Promise<ServeResult> {
  const entry = SERVERS[req.language];
  if (!entry) {
    throw new ExecuteError('unsupported_language', `Unsupported language: ${req.language}`);
  }

  const sourceBytes = Buffer.byteLength(req.source, 'utf8');
  if (sourceBytes > MAX_SOURCE_BYTES) {
    throw new ExecuteError(
      'source_too_large',
      `Source is ${sourceBytes} bytes; limit is ${MAX_SOURCE_BYTES}.`,
    );
  }

  const packages = req.packages ?? [];
  if (packages.length > 0) validatePackages(packages);

  const leaseSeconds = Math.round(
    clamp(req.leaseSeconds ?? DEFAULT_LEASE_SECONDS, 10, MAX_LEASE_SECONDS),
  );
  const installer = INSTALLERS[req.language];
  const startedAt = Date.now();

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      runtime: RUNTIMES[req.language],
      ports: [SERVE_PORT],
      networkPolicy: packages.length > 0 ? { allow: installer.allow } : 'deny-all',
      // Self-terminating: the VM outlives neither the lease nor a crashed request of ours.
      timeout: leaseSeconds * 1000 + (packages.length > 0 ? INSTALL_TIMEOUT_MS : 0),
      resources: { vcpus: VCPUS },
      env: { PORT: String(SERVE_PORT) },
    });
  } catch (err) {
    throw new ExecuteError('sandbox_failed', `Could not create sandbox: ${String(err)}`);
  }

  try {
    if (packages.length > 0) {
      let installed;
      try {
        installed = await sandbox.runCommand({
          cmd: installer.cmd,
          args: installer.args(packages),
          signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        });
      } catch (err) {
        if (!isAbort(err)) throw err;
        throw new ExecuteError(
          'install_failed',
          `Installing ${packages.join(', ')} exceeded ${INSTALL_TIMEOUT_MS / 1000}s.`,
        );
      }
      if (installed.exitCode !== 0) {
        const why = (await installed.stderr()).trim().slice(0, 400);
        throw new ExecuteError('install_failed', why || `Could not install ${packages.join(', ')}.`);
      }
      // Nothing untrusted has touched this VM yet. Cut the network before it does.
      await sandbox.updateNetworkPolicy('deny-all');
    }

    await sandbox.writeFiles([{ path: entry.file, content: Buffer.from(req.source, 'utf8') }]);
    await sandbox.runCommand({ cmd: entry.cmd, args: entry.args, detached: true });

    const url = sandbox.domain(SERVE_PORT);

    // Don't hand back a URL that 502s. A caller pays for a page, not for a promise.
    const deadline = Date.now() + LISTEN_TIMEOUT_MS;
    let listening = false;
    while (Date.now() < deadline) {
      try {
        const probe = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (probe.status < 500) {
          listening = true;
          break;
        }
      } catch {
        /* not bound yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!listening) {
      throw new ExecuteError(
        'never_listened',
        `Nothing answered on $PORT (${SERVE_PORT}) within ${LISTEN_TIMEOUT_MS / 1000}s.`,
      );
    }

    return {
      url,
      sandboxId: sandbox.sandboxId,
      leaseSeconds,
      expiresAt: Date.now() + leaseSeconds * 1000,
      bootMs: Date.now() - startedAt,
    };
  } catch (err) {
    // A lease that never served is a lease we do not keep alive.
    void sandbox.stop().catch(() => {});
    throw err;
  }
}
