import assert from 'node:assert/strict';

/**
 * Lease admission: the abuse controls that make anonymous public hosting shippable.
 *
 * In-memory path only — clear the store env before importing, or these would write to the
 * production lease keys.
 */
for (const name of [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
]) {
  delete process.env[name];
}

const { admitLease, liveLeases, resetGuards } = await import('../src/guards.js');

const A = '0xaaaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';

// One live lease per wallet.
resetGuards();
const first = await admitLease(A, 120);
assert.ok(first.ok, 'first lease admitted');
const second = await admitLease(A, 120);
assert.ok(!second.ok && second.denied.code === 'lease_limit', 'same wallet is capped at one');

// A different wallet is unaffected.
const other = await admitLease(B, 120);
assert.ok(other.ok, 'a different wallet gets its own lease');
assert.equal(await liveLeases(), 2, 'two live leases across two payers');

// Releasing frees the wallet to lease again — the failed-lease refund path.
if (first.ok) await first.release();
const again = await admitLease(A, 120);
assert.ok(again.ok, 'wallet can lease again after release');

// A short lease expiring frees its slot without an explicit release.
resetGuards();
const brief = await admitLease(A, 10); // clamped to a 10s floor
assert.ok(brief.ok);
assert.equal(await liveLeases(), 1);
// Advance past expiry by faking the clock — liveLeases prunes by score.
const realNow = Date.now;
Date.now = () => realNow() + 11_000;
try {
  assert.equal(await liveLeases(), 0, 'expired lease no longer counts');
  const afterExpiry = await admitLease(A, 120);
  assert.ok(afterExpiry.ok, 'wallet can lease once its old one expired');
} finally {
  Date.now = realNow;
}

// Global concurrency ceiling holds across distinct payers.
resetGuards();
const wallets = Array.from({ length: 5 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
const results = [];
for (const w of wallets) results.push(await admitLease(w, 120));
const admitted = results.filter((r) => r.ok).length;
assert.equal(admitted, 3, 'global lease ceiling is 3 regardless of distinct payers');
assert.ok(
  results.slice(3).every((r) => !r.ok && r.denied.code === 'too_busy'),
  'the rest are turned away as too_busy',
);

console.log('all lease guard assertions passed');
