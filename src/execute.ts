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
      | 'install_failed',
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

const RUNTIMES: Record<Language, 'node24' | 'python3.13'> = {
  node: 'node24',
  python: 'python3.13',
};

const ENTRYPOINTS: Record<Language, { file: string; cmd: string; args: string[] }> = {
  node: { file: 'main.js', cmd: 'node', args: ['main.js'] },
  python: { file: 'main.py', cmd: 'python3', args: ['main.py'] },
};

export const MAX_PACKAGES = 5;
export const INSTALL_TIMEOUT_MS = 45_000;

/**
 * Names only. A leading `-` would be read as a flag, and a `/`, `:` or `@git+` would
 * let a caller install from an arbitrary URL — both turn `packages` into arbitrary
 * command execution with the network still up.
 */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Least privilege even during install: the registry and its CDN, nothing else. */
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
      ...packages,
    ],
    allow: ['pypi.org', 'files.pythonhosted.org'],
  },
  node: {
    cmd: 'npm',
    args: (packages) => ['install', '--no-audit', '--no-fund', '--loglevel=error', ...packages],
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
