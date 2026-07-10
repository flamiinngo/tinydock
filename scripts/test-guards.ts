import assert from 'node:assert/strict';

/**
 * These assert the in-memory fallback and must never touch a live store — running them
 * against production Redis would corrupt the real budget and rate-limit keys. `store.ts`
 * resolves its client lazily on first use, so clearing the env here is enough.
 */
for (const name of [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
]) {
  delete process.env[name];
}

const { admit, recordUsage, resetGuards, usageSnapshot } = await import('../src/guards.js');
type Kind = 'paid' | 'demo';

async function attempt(callerId: string, kind: Kind = 'paid'): Promise<string> {
  const result = await admit(callerId, kind);
  if (result.ok) {
    result.release();
    return 'allowed';
  }
  return result.denied.code;
}

// Paid rate limit is 6/min and scoped per caller.
resetGuards();
for (let i = 0; i < 6; i++) assert.equal(await attempt('1.2.3.4'), 'allowed', `call ${i + 1}`);
assert.equal(await attempt('1.2.3.4'), 'rate_limited');
assert.equal(await attempt('5.6.7.8'), 'allowed', 'a different caller is unaffected');

// Demo rate limit is 1/min, and its bucket is separate from the same caller's paid bucket.
resetGuards();
assert.equal(await attempt('9.9.9.9', 'demo'), 'allowed');
assert.equal(await attempt('9.9.9.9', 'demo'), 'rate_limited');
assert.equal(await attempt('9.9.9.9', 'paid'), 'allowed', 'paid bucket is independent');

// Concurrency is shared across kinds and released explicitly.
resetGuards();
const held = [await admit('a', 'paid'), await admit('b', 'demo'), await admit('c', 'paid')];
assert.ok(held.every((h) => h.ok));
assert.equal(await attempt('d'), 'too_busy');
for (const h of held) if (h.ok) h.release();
assert.equal(await attempt('d'), 'allowed', 'slots free after release');

// A double release must not leak capacity.
resetGuards();
const one = await admit('x', 'paid');
assert.ok(one.ok);
if (one.ok) {
  one.release();
  one.release();
}
assert.equal((await usageSnapshot()).inFlight, 0);

// Demo exhaustion must not starve paying agents.
resetGuards();
await recordUsage('demo', 20 * 60 * 1000);
assert.equal(await attempt('fresh', 'demo'), 'demo_exhausted');
assert.equal(await attempt('fresh', 'paid'), 'allowed', 'paid traffic survives a spent demo budget');

// Paid exhaustion outranks everything, including for a caller who has never called.
resetGuards();
await recordUsage('paid', 3 * 60 * 60 * 1000);
assert.equal(await attempt('newcomer', 'paid'), 'budget_exhausted');

console.log('all guard assertions passed');
