import type { IncomingMessage, ServerResponse } from 'node:http';
import { ExecuteError, execute } from './execute.js';
import { recordExecution } from './feed.js';
import { admit, callerIdOf, recordUsage } from './guards.js';
import { findPreset } from './presets.js';

const DEMO_TIMEOUT_MS = 2_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * The free cabinet play. Visitors name a preset; they never send source.
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const preset = findPreset(url.searchParams.get('preset'));
  if (!preset) {
    json(res, 400, { error: 'unknown_preset', message: 'Pick one of the listed presets.' });
    return;
  }

  const admission = admit(callerIdOf(req), 'demo');
  if (!admission.ok) {
    if (admission.denied.retryAfterSeconds) {
      res.setHeader('Retry-After', String(admission.denied.retryAfterSeconds));
    }
    json(res, admission.denied.status, {
      error: admission.denied.code,
      message: admission.denied.message,
    });
    return;
  }

  try {
    const result = await execute({
      language: preset.language,
      source: preset.source,
      timeoutMs: DEMO_TIMEOUT_MS,
    });
    // Billed on total wall clock; displayed as the program's own runtime.
    recordUsage('demo', result.durationMs);
    recordExecution({
      language: preset.language,
      runMs: result.runMs,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      demo: true,
    });

    json(res, 200, {
      preset: preset.id,
      language: preset.language,
      source: preset.source,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnMs: result.spawnMs,
      runMs: result.runMs,
    });
  } catch (err) {
    const code = err instanceof ExecuteError ? err.code : 'sandbox_failed';
    json(res, 502, { error: code, message: 'The sandbox could not be created.' });
  } finally {
    admission.release();
  }
}
