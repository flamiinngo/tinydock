import type { IncomingMessage } from 'node:http';

/**
 * Admission control.
 *
 * State is per-instance and in memory. Vercel Functions are stateless, so under the
 * concurrency that spawns several warm instances each keeps its own counters — meaning
 * the fleet can overshoot a budget that any single instance respects. The guard is
 * weakest under exactly the load it exists to stop. A shared counter (Upstash) fixes it.
 */

/** Vercel Hobby pauses sandbox creation past 5 CPU-hours/month, which takes the ASP offline. */
const HOBBY_BUDGET_MS = 5 * 60 * 60 * 1000;

/** Stop at 60% so a bad Tuesday can't cost us judging day. */
const PAID_BUDGET_MS = Number(process.env.TINYDOCK_BUDGET_MS ?? Math.floor(HOBBY_BUDGET_MS * 0.6));

/** The public cabinet gets its own small allowance. Paying agents must never starve. */
const DEMO_BUDGET_MS = Number(process.env.TINYDOCK_DEMO_BUDGET_MS ?? 20 * 60 * 1000);

const MAX_CONCURRENT = Number(process.env.TINYDOCK_MAX_CONCURRENT ?? 3);
const PAID_CALLS_PER_MINUTE = Number(process.env.TINYDOCK_RATE_PER_MIN ?? 6);
const DEMO_CALLS_PER_MINUTE = Number(process.env.TINYDOCK_DEMO_RATE_PER_MIN ?? 1);
const RATE_WINDOW_MS = 60_000;

export type Kind = 'paid' | 'demo';

export interface Denied {
  status: number;
  code: 'budget_exhausted' | 'demo_exhausted' | 'rate_limited' | 'too_busy';
  message: string;
  retryAfterSeconds?: number;
}

export type Admission = { ok: true; release: () => void } | { ok: false; denied: Denied };

let inFlight = 0;
const windows = new Map<string, { count: number; resetAt: number }>();
let usage = { month: monthKey(), paidMs: 0, demoMs: 0 };

function monthKey(): string {
  return new Date().toISOString().slice(0, 7);
}

function rollMonth(): void {
  if (usage.month !== monthKey()) usage = { month: monthKey(), paidMs: 0, demoMs: 0 };
}

export function callerIdOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return raw?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

/** Wall clock, which overstates the active CPU Vercel bills. Conservative on purpose. */
export function recordUsage(kind: Kind, durationMs: number): void {
  rollMonth();
  if (kind === 'paid') usage.paidMs += durationMs;
  else usage.demoMs += durationMs;
}

export function usageSnapshot(): {
  paidUsedRatio: number;
  demoUsedRatio: number;
  inFlight: number;
  demoExhausted: boolean;
} {
  rollMonth();
  return {
    paidUsedRatio: Math.min(1, usage.paidMs / PAID_BUDGET_MS),
    demoUsedRatio: Math.min(1, usage.demoMs / DEMO_BUDGET_MS),
    inFlight,
    demoExhausted: usage.demoMs >= DEMO_BUDGET_MS,
  };
}

function checkRate(callerId: string, limit: number, now: number): Denied | undefined {
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);

  const window = windows.get(callerId);
  if (!window) {
    windows.set(callerId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return undefined;
  }
  if (window.count >= limit) {
    return {
      status: 429,
      code: 'rate_limited',
      message: `Rate limit is ${limit} call${limit === 1 ? '' : 's'} per minute.`,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }
  window.count += 1;
  return undefined;
}

/**
 * Call before taking payment. Charging an agent and then refusing to run its code
 * because the sandbox budget is gone is the one failure we cannot ship.
 */
export function admit(callerId: string, kind: Kind): Admission {
  const now = Date.now();
  rollMonth();

  const spent = kind === 'paid' ? usage.paidMs : usage.demoMs;
  const allowance = kind === 'paid' ? PAID_BUDGET_MS : DEMO_BUDGET_MS;
  if (spent >= allowance) {
    return {
      ok: false,
      denied:
        kind === 'paid'
          ? {
              status: 503,
              code: 'budget_exhausted',
              message: 'Monthly execution budget is exhausted. Service resumes next cycle.',
            }
          : {
              status: 503,
              code: 'demo_exhausted',
              message: 'The free demo allowance is spent for this month. Paid calls still run.',
            },
    };
  }

  if (inFlight >= MAX_CONCURRENT) {
    return {
      ok: false,
      denied: {
        status: 429,
        code: 'too_busy',
        message: `At capacity (${MAX_CONCURRENT} concurrent executions).`,
        retryAfterSeconds: 5,
      },
    };
  }

  const limit = kind === 'paid' ? PAID_CALLS_PER_MINUTE : DEMO_CALLS_PER_MINUTE;
  const rateDenial = checkRate(`${kind}:${callerId}`, limit, now);
  if (rateDenial) return { ok: false, denied: rateDenial };

  inFlight += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    },
  };
}

/** Test seam. */
export function resetGuards(): void {
  inFlight = 0;
  windows.clear();
  usage = { month: monthKey(), paidMs: 0, demoMs: 0 };
}
