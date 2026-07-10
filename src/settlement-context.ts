import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Carries a settlement from the payment gate to the execution it paid for.
 *
 * A module-level variable cannot do this. `MAX_CONCURRENT` permits overlapping paid
 * calls inside one instance and `execute()` awaits for seconds between the two points,
 * so two in-flight requests would cross-claim each other's txHash — and a paid call that
 * threw would leave its settlement behind for the next execution, free demo included,
 * to pick up and display as its own.
 */
export interface SettlementSlot {
  paidUsd?: number;
  txHash?: string;
}

export const settlementContext = new AsyncLocalStorage<SettlementSlot>();
