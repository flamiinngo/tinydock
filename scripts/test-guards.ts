import assert from 'node:assert/strict';
import { type Kind, admit, recordUsage, resetGuards, usageSnapshot } from '../src/guards.js';

function attempt(callerId: string, kind: Kind = 'paid'): string {
  const result = admit(callerId, kind);
  if (result.ok) {
    result.release();
    return 'allowed';
  }
  return result.denied.code;
}

// Paid rate limit is 6/min and scoped per caller.
resetGuards();
for (let i = 0; i < 6; i++) assert.equal(attempt('1.2.3.4'), 'allowed', `call ${i + 1}`);
assert.equal(attempt('1.2.3.4'), 'rate_limited');
assert.equal(attempt('5.6.7.8'), 'allowed', 'a different caller is unaffected');

// Demo rate limit is 1/min, and its bucket is separate from the same caller's paid bucket.
resetGuards();
assert.equal(attempt('9.9.9.9', 'demo'), 'allowed');
assert.equal(attempt('9.9.9.9', 'demo'), 'rate_limited');
assert.equal(attempt('9.9.9.9', 'paid'), 'allowed', 'paid bucket is independent');

// Concurrency is shared across kinds and released explicitly.
resetGuards();
const held = [admit('a', 'paid'), admit('b', 'demo'), admit('c', 'paid')];
assert.ok(held.every((h) => h.ok));
assert.equal(attempt('d'), 'too_busy');
for (const h of held) if (h.ok) h.release();
assert.equal(attempt('d'), 'allowed', 'slots free after release');

// A double release must not leak capacity.
resetGuards();
const one = admit('x', 'paid');
assert.ok(one.ok);
if (one.ok) {
  one.release();
  one.release();
}
assert.equal(usageSnapshot().inFlight, 0);

// Demo exhaustion must not starve paying agents.
resetGuards();
recordUsage('demo', 20 * 60 * 1000);
assert.equal(attempt('fresh', 'demo'), 'demo_exhausted');
assert.equal(attempt('fresh', 'paid'), 'allowed', 'paid traffic survives a spent demo budget');

// Paid exhaustion outranks everything, including for a caller who has never called.
resetGuards();
recordUsage('paid', 3 * 60 * 60 * 1000);
assert.equal(attempt('newcomer', 'paid'), 'budget_exhausted');

console.log('all guard assertions passed');
