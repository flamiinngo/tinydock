import { Redis } from '@upstash/redis';

/**
 * The shared store behind the feed and the abuse guards.
 *
 * Vercel Functions are stateless: instances are recycled freely and several run warm at
 * once. Anything kept in process memory is per-instance, so the cabinet's counters drift
 * and the budget ceiling is enforced by each instance against its own private tally —
 * the guard is weakest under exactly the concurrency it exists to stop.
 *
 * Redis makes both shared. It is optional: with no credentials the callers fall back to
 * process memory, which is what local development and `scripts/test-*.ts` rely on.
 *
 * A store outage must never take a paid request down. `viaRedis` swallows the error and
 * hands back the in-memory answer instead. The numbers go approximate for the duration;
 * the money does not, because settlement lives on chain and not in here.
 */

/** Upstash's own names, and the ones the Vercel KV integration used to emit. */
const URL_KEYS = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'];
const TOKEN_KEYS = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'];

const firstSet = (names: string[]): string | undefined =>
  names.map((name) => process.env[name]).find((value) => value !== undefined && value !== '');

let cached: Redis | null | undefined;

export function redis(): Redis | null {
  if (cached !== undefined) return cached;

  const url = firstSet(URL_KEYS);
  const token = firstSet(TOKEN_KEYS);
  cached = url && token ? new Redis({ url, token }) : null;
  return cached;
}

export const storeIsShared = (): boolean => redis() !== null;

let warned = false;

/**
 * Run `withStore` against Redis, or `inMemory` if there is no Redis or Redis fails.
 *
 * The fallback is deliberately not a retry. A paid caller is already waiting on a block
 * confirmation; making them wait on our cache too, to produce a number nobody bills from,
 * is the wrong trade.
 */
export async function viaRedis<T>(
  withStore: (client: Redis) => Promise<T>,
  inMemory: () => T,
): Promise<T> {
  const client = redis();
  if (!client) return inMemory();

  try {
    return await withStore(client);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.error('store: redis unreachable, serving from process memory', err);
    }
    return inMemory();
  }
}

/** Month-scoped keys, so the budget rolls over without a cron. */
export const monthKey = (): string => new Date().toISOString().slice(0, 7);

export const KEYS = {
  executions: 'td:executions',
  earnedUsd: 'td:earned_usd',
  recent: 'td:recent',
  usage: (kind: string, month: string) => `td:usage:${kind}:${month}`,
  rate: (kind: string, callerId: string) => `td:rate:${kind}:${callerId}`,
  /** Sorted sets scored by lease expiry, so a crashed request cannot leak a slot forever. */
  leases: 'td:leases',
  payerLeases: (payer: string) => `td:leases:${payer}`,
  leaseRate: (payer: string) => `td:leaserate:${payer}`,
} as const;
