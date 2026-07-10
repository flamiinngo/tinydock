import type { Language } from './execute.js';

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

/** Set by the payment gate just before the tool runs; claimed by the execution it paid for. */
let pendingSettlement: { paidUsd: number; txHash?: string } | undefined;

export function recordSettlement(paidUsd: number, txHash?: string): void {
  pendingSettlement = { paidUsd, txHash };
  totalEarnedUsd += paidUsd;
}

export function recordExecution(event: Omit<FeedEvent, 'at' | 'paidUsd' | 'txHash'>): void {
  const settled = pendingSettlement;
  pendingSettlement = undefined;

  totalExecutions += 1;
  events.unshift({ ...event, at: Date.now(), ...settled });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

export function stats(): {
  totalExecutions: number;
  totalEarnedUsd: number;
  recent: FeedEvent[];
} {
  return { totalExecutions, totalEarnedUsd, recent: [...events] };
}
