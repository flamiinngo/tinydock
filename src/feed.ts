import type { Language } from './execute.js';
import { settlementContext } from './settlement-context.js';

/**
 * Recent activity, for the public cabinet display.
 *
 * Deliberately excludes source and stdout. Callers are untrusted, the page is public,
 * and rendering either would leak whatever an agent printed and hand us an injection
 * vector. Metadata is enough to prove the machine is running.
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
 * Attribution to a specific feed event goes through the request's own slot.
 */
export function recordSettlement(paidUsd: number, txHash?: string): void {
  totalEarnedUsd += paidUsd;

  const slot = settlementContext.getStore();
  if (slot) {
    slot.paidUsd = paidUsd;
    slot.txHash = txHash;
  }
}

export function recordExecution(event: Omit<FeedEvent, 'at' | 'paidUsd' | 'txHash'>): void {
  const slot = settlementContext.getStore();
  const settled =
    slot?.paidUsd === undefined ? {} : { paidUsd: slot.paidUsd, txHash: slot.txHash };

  totalExecutions += 1;
  events.unshift({ ...event, at: Date.now(), ...settled });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

/** Test seam. */
export function resetFeed(): void {
  events.length = 0;
  totalExecutions = 0;
  totalEarnedUsd = 0;
}

export function stats(): {
  totalExecutions: number;
  totalEarnedUsd: number;
  recent: FeedEvent[];
} {
  return { totalExecutions, totalEarnedUsd, recent: [...events] };
}
