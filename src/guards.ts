import type { IncomingMessage } from 'node:http';
import { KEYS, monthKey, viaRedis } from './store.js';

/**
 * Admission control.
 *
 * The budget ceiling and the per-caller rate limit live in Redis when it is configured,
 * because both are fleet-wide facts. Held in process memory they were enforced by each
 * warm instance against its own private tally: the budget overshot under concurrency, and
 * a caller could evade the rate limit simply by landing on a different instance. Both
 * guards were weakest under exactly the load they exist to stop.
 *
 * `inFlight` stays per-instance on purpose. It caps how much one process oversubscribes
 * itself, and a fleet-wide version would need lease expiry to survive a request that dies
 * mid-execution — a distributed lock protecting a local resource.
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
const RATE_WINDOW_SECONDS = 60;

/** Long enough that a month's usage key outlives the month; short enough not to accrete. */
const USAGE_TTL_SECONDS = 70 * 24 * 60 * 60;

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

function rollMonth(): void {
  if (usage.month !== monthKey()) usage = { month: monthKey(), paidMs: 0, demoMs: 0 };
}

export function callerIdOf(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return raw?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

const allowanceFor = (kind: Kind): number => (kind === 'paid' ? PAID_BUDGET_MS : DEMO_BUDGET_MS);

/** Wall clock, which overstates the active CPU Vercel bills. Conservative on purpose. */
export async function recordUsage(kind: Kind, durationMs: number): Promise<void> {
  rollMonth();

  await viaRedis(
    async (client) => {
      const key = KEYS.usage(kind, monthKey());
      await client.incrby(key, Math.round(durationMs));
      await client.expire(key, USAGE_TTL_SECONDS);
    },
    () => {
      if (kind === 'paid') usage.paidMs += durationMs;
      else usage.demoMs += durationMs;
    },
  );
}

async function spentMs(kind: Kind): Promise<number> {
  return viaRedis(
    async (client) => Number((await client.get<number>(KEYS.usage(kind, monthKey()))) ?? 0),
    () => (kind === 'paid' ? usage.paidMs : usage.demoMs),
  );
}

export async function usageSnapshot(): Promise<{
  paidUsedRatio: number;
  demoUsedRatio: number;
  inFlight: number;
  demoExhausted: boolean;
}> {
  rollMonth();
  const [paidMs, demoMs] = await Promise.all([spentMs('paid'), spentMs('demo')]);

  return {
    paidUsedRatio: Math.min(1, paidMs / PAID_BUDGET_MS),
    demoUsedRatio: Math.min(1, demoMs / DEMO_BUDGET_MS),
    inFlight,
    demoExhausted: demoMs >= DEMO_BUDGET_MS,
  };
}

/**
 * One call against the window. Returns the denial if this call put the caller over.
 *
 * Redis counts the call as it checks it, so two concurrent requests cannot both read a
 * count below the limit and both proceed. The in-memory path keeps its old semantics.
 */
async function checkRate(key: string, limit: number): Promise<Denied | undefined> {
  const over = (retryAfterSeconds: number): Denied => ({
    status: 429,
    code: 'rate_limited',
    message: `Rate limit is ${limit} call${limit === 1 ? '' : 's'} per minute.`,
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
  });

  return viaRedis(
    async (client) => {
      const count = await client.incr(key);
      if (count === 1) await client.expire(key, RATE_WINDOW_SECONDS);
      if (count <= limit) return undefined;

      const ttl = await client.ttl(key);
      return over(ttl > 0 ? ttl : RATE_WINDOW_SECONDS);
    },
    () => {
      const now = Date.now();
      for (const [k, window] of windows) if (window.resetAt <= now) windows.delete(k);

      const window = windows.get(key);
      if (!window) {
        windows.set(key, { count: 1, resetAt: now + RATE_WINDOW_SECONDS * 1000 });
        return undefined;
      }
      if (window.count >= limit) return over(Math.ceil((window.resetAt - now) / 1000));

      window.count += 1;
      return undefined;
    },
  );
}

/**
 * Call before taking payment. Charging an agent and then refusing to run its code
 * because the sandbox budget is gone is the one failure we cannot ship.
 */
export async function admit(callerId: string, kind: Kind): Promise<Admission> {
  rollMonth();

  const spent = await spentMs(kind);
  if (spent >= allowanceFor(kind)) {
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
  const rateDenial = await checkRate(KEYS.rate(kind, callerId), limit);
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

/** Test seam. Clears the in-memory copy only. */
export function resetGuards(): void {
  inFlight = 0;
  windows.clear();
  usage = { month: monthKey(), paidMs: 0, demoMs: 0 };
}
