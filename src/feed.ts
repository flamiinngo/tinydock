import type { Language } from './execute.js';
import { settlementContext } from './settlement-context.js';
import { KEYS, viaRedis } from './store.js';

/**
 * Recent activity, for the public cabinet display.
 *
 * Deliberately excludes source and stdout. Callers are untrusted, the page is public,
 * and rendering either would leak whatever an agent printed and hand us an injection
 * vector. Metadata is enough to prove the machine is running.
 *
 * Shared across instances when Redis is configured; per-instance otherwise. See store.ts.
 */
export interface FeedEvent {
  at: number;
  language: Language;
  /** The program's own runtime. Sandbox boot is our cost and is not shown to callers. */
  runMs: number;
  exitCode: number;
  timedOut: boolean;
  demo: boolean;
  paidUsd?: number;
  txHash?: string;
}

const MAX_EVENTS = 12;

const events: FeedEvent[] = [];
let totalExecutions = 0;
let totalEarnedUsd = 0;

/**
 * The money is ours the moment it settles, whether or not the program then runs.
 * Attribution to a specific feed event goes through the request's own slot: a module
 * global cannot survive concurrent paid calls, and a settled-then-failed call would
 * leave its transaction behind for the next execution — a free demo — to display.
 */
export async function recordSettlement(paidUsd: number, txHash?: string): Promise<void> {
  const slot = settlementContext.getStore();
  if (slot) {
    slot.paidUsd = paidUsd;
    slot.txHash = txHash;
  }

  await viaRedis(
    async (client) => {
      await client.incrbyfloat(KEYS.earnedUsd, paidUsd);
    },
    () => {
      totalEarnedUsd += paidUsd;
    },
  );
}

export async function recordExecution(
  event: Omit<FeedEvent, 'at' | 'paidUsd' | 'txHash'>,
): Promise<void> {
  const slot = settlementContext.getStore();
  const settled =
    slot?.paidUsd === undefined ? {} : { paidUsd: slot.paidUsd, txHash: slot.txHash };
  const full: FeedEvent = { ...event, at: Date.now(), ...settled };

  await viaRedis(
    async (client) => {
      await client
        .pipeline()
        .incr(KEYS.executions)
        .lpush(KEYS.recent, JSON.stringify(full))
        .ltrim(KEYS.recent, 0, MAX_EVENTS - 1)
        .exec();
    },
    () => {
      totalExecutions += 1;
      events.unshift(full);
      if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    },
  );
}

/** Upstash decodes JSON strings on read; a plain object is already what we stored. */
function asEvent(raw: unknown): FeedEvent | undefined {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as FeedEvent;
    } catch {
      return undefined;
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as FeedEvent) : undefined;
}

export async function stats(): Promise<{
  totalExecutions: number;
  totalEarnedUsd: number;
  recent: FeedEvent[];
}> {
  return viaRedis(
    async (client) => {
      const [executions, earned, recent] = await client
        .pipeline()
        .get<number>(KEYS.executions)
        .get<string>(KEYS.earnedUsd)
        .lrange(KEYS.recent, 0, MAX_EVENTS - 1)
        .exec<[number | null, string | null, unknown[]]>();

      return {
        totalExecutions: Number(executions ?? 0),
        // INCRBYFLOAT round-trips as a string; a raw Number() of it can carry float noise.
        totalEarnedUsd: Math.round(Number(earned ?? 0) * 1e6) / 1e6,
        recent: (recent ?? []).map(asEvent).filter((e): e is FeedEvent => e !== undefined),
      };
    },
    () => ({ totalExecutions, totalEarnedUsd, recent: [...events] }),
  );
}

/** Test seam. Clears the in-memory copy only. */
export function resetFeed(): void {
  events.length = 0;
  totalExecutions = 0;
  totalEarnedUsd = 0;
}
