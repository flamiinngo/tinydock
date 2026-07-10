import { recordExecution, recordSettlement, resetFeed, stats } from '../src/feed.js';
import { settlementContext } from '../src/settlement-context.js';

/**
 * The feed attributes a settlement to the execution that paid for it, and to no other.
 *
 * These are the two ways the old module-global `pendingSettlement` got it wrong: a second
 * paid call overwrote the first's txHash mid-flight, and a paid call that threw left its
 * settlement lying around for the next execution — a free demo — to display as its own.
 */

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`);
  if (!ok) failures += 1;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** One request: open a slot, settle, wait (as `execute()` would), then record. */
async function paidCall(txHash: string, price: number, delayMs: number): Promise<void> {
  await settlementContext.run({}, async () => {
    recordSettlement(price, txHash);
    await new Promise((r) => setTimeout(r, delayMs));
    recordExecution({ language: 'python', runMs: 1, exitCode: 0, timedOut: false, demo: false });
  });
}

// ── Two paid calls overlap. Each event must carry its own transaction.
resetFeed();
await Promise.all([paidCall('0xAAA', 0.01, 40), paidCall('0xBBB', 0.01, 5)]);

{
  const { recent, totalExecutions, totalEarnedUsd } = stats();
  const byTx = new Map(recent.map((e) => [e.txHash, e]));

  check('both executions recorded', totalExecutions === 2, `got ${totalExecutions}`);
  check('both settlements counted', Math.abs(totalEarnedUsd - 0.02) < 1e-9, `got ${totalEarnedUsd}`);
  check('no execution lost its txHash', recent.every((e) => e.txHash !== undefined));
  check('txHashes are distinct — no cross-claim', byTx.size === 2, `saw ${[...byTx.keys()].join(', ')}`);
  check('0xAAA present exactly once', recent.filter((e) => e.txHash === '0xAAA').length === 1);
  check('0xBBB present exactly once', recent.filter((e) => e.txHash === '0xBBB').length === 1);
}

// ── A paid call settles, then throws before recording. Its settlement must not leak.
resetFeed();
await settlementContext
  .run({}, async () => {
    recordSettlement(0.01, '0xDEAD');
    await tick();
    throw new Error('execute() failed after settlement');
  })
  .catch(() => {});

// The next thing to run is a free demo, outside any slot.
recordExecution({ language: 'python', runMs: 1, exitCode: 0, timedOut: false, demo: true });

{
  const { recent, totalEarnedUsd } = stats();
  const demo = recent[0];

  check('earnings still counted for the settled-then-failed call', Math.abs(totalEarnedUsd - 0.01) < 1e-9);
  check('the free demo is not marked paid', demo?.paidUsd === undefined, `paidUsd=${demo?.paidUsd}`);
  check('the free demo carries no txHash', demo?.txHash === undefined, `txHash=${demo?.txHash}`);
  check('the free demo is still flagged demo', demo?.demo === true);
}

console.log(failures === 0 ? '\nall feed invariants hold' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
