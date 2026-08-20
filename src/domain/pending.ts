import {
  activeRecoveryAmount,
  affectsBookBalance,
  isRecoverableExpenseTreatment,
} from "./entry-treatment";
import type {
  IncomeForecast,
  LedgerEntry,
  RecoveryAllocation,
  SpendingAnalysis,
} from "./types";

interface PendingItemBase {
  id: string;
  sortAt: string;
}

export interface PendingIncomeItem extends PendingItemBase {
  kind: "income_due";
  forecast: IncomeForecast;
}

export interface PendingTreatmentItem extends PendingItemBase {
  kind: "entry_treatment";
  entry: LedgerEntry;
}

export interface PendingSavingsItem extends PendingItemBase {
  kind: "savings_penetration";
  sourceEntry?: LedgerEntry;
  suggestedAmountMinor: number;
}

export interface PendingRecoveryItem extends PendingItemBase {
  kind: "recovery_link";
  refund: LedgerEntry;
  remainingAmountMinor: number;
  candidateCount: number;
}

export type PendingItem =
  | PendingIncomeItem
  | PendingTreatmentItem
  | PendingSavingsItem
  | PendingRecoveryItem;

export interface PendingItemsInput {
  entries: readonly LedgerEntry[];
  allocations: readonly RecoveryAllocation[];
  incomeForecast?: IncomeForecast;
  retainedMinor: bigint;
  balanceMinor: number;
  todayDateKey: string;
  analysis?: SpendingAnalysis;
}

function recoveryCandidateCount(
  refund: LedgerEntry,
  entries: readonly LedgerEntry[],
  allocations: readonly RecoveryAllocation[],
): number {
  return entries.filter((expense) => {
    if (
      expense.id === refund.id ||
      expense.deletedAt ||
      expense.amountMinor >= 0 ||
      expense.occurredAt > refund.occurredAt ||
      !isRecoverableExpenseTreatment(expense.treatment)
    ) return false;
    const recovered = activeRecoveryAmount(
      allocations,
      (allocation) => allocation.expenseEntryId === expense.id,
    );
    return recovered < Math.abs(expense.amountMinor);
  }).length;
}

const priorities: Record<PendingItem["kind"], number> = {
  income_due: 0,
  entry_treatment: 1,
  savings_penetration: 2,
  recovery_link: 3,
};

export function derivePendingItems(input: PendingItemsInput): PendingItem[] {
  const items: PendingItem[] = [];
  const activeEntries = input.entries.filter((entry) => !entry.deletedAt);

  if (
    input.incomeForecast &&
    input.incomeForecast.targetPaydayDateKey <= input.todayDateKey
  ) {
    items.push({
      id: `income:${input.incomeForecast.id}`,
      kind: "income_due",
      forecast: input.incomeForecast,
      sortAt: input.incomeForecast.targetPaydayDateKey,
    });
  }

  for (const entry of activeEntries) {
    // v7 stored user-confirmed salary receipts as not_needed. Keep those
    // canonical rows out of the exception queue after upgrading to v8.
    if (
      entry.amountMinor > 0 &&
      entry.note === "本次实际收入" &&
      entry.treatment === "ordinary_income" &&
      entry.confirmationStatus === "not_needed" &&
      !entry.attachmentId
    ) continue;
    // Detection happens immediately after a successful create/edit. Only the
    // persisted pending state belongs in the durable queue; never re-run a new
    // heuristic over historical rows while deriving UI state.
    if (entry.confirmationStatus !== "pending") continue;
    items.push({
      id: `treatment:${entry.id}`,
      kind: "entry_treatment",
      entry,
      sortAt: entry.updatedAt,
    });
  }

  const penetrationMinor = input.retainedMinor - BigInt(input.balanceMinor);
  if (input.retainedMinor > 0n && penetrationMinor > 0n) {
    const sourceEntry = activeEntries
      .filter((entry) => entry.amountMinor < 0 && affectsBookBalance(entry))
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
    const expenseCap = sourceEntry ? BigInt(Math.abs(sourceEntry.amountMinor)) : penetrationMinor;
    const suggestion = [penetrationMinor, input.retainedMinor, expenseCap]
      .reduce((smallest, value) => value < smallest ? value : smallest);
    if (suggestion > 0n && suggestion <= BigInt(Number.MAX_SAFE_INTEGER)) {
      items.push({
        id: `savings:${sourceEntry?.id ?? "balance"}`,
        kind: "savings_penetration",
        sourceEntry,
        suggestedAmountMinor: Number(suggestion),
        sortAt: sourceEntry?.updatedAt ?? input.todayDateKey,
      });
    }
  }

  for (const refund of activeEntries) {
    if (refund.amountMinor <= 0 || refund.treatment !== "refund_reimbursement") continue;
    const allocated = activeRecoveryAmount(
      input.allocations,
      (allocation) => allocation.refundEntryId === refund.id,
    );
    const remainingAmountMinor = refund.amountMinor - allocated;
    if (remainingAmountMinor <= 0) continue;
    const candidateCount = recoveryCandidateCount(refund, activeEntries, input.allocations);
    if (candidateCount === 0) continue;
    items.push({
      id: `recovery:${refund.id}`,
      kind: "recovery_link",
      refund,
      remainingAmountMinor,
      candidateCount,
      sortAt: refund.updatedAt,
    });
  }

  return items.sort((left, right) =>
    priorities[left.kind] - priorities[right.kind] ||
    left.sortAt.localeCompare(right.sortAt) ||
    left.id.localeCompare(right.id));
}

export function filterSnoozedPendingItems(
  items: readonly PendingItem[],
  dismissals: Readonly<Record<string, string>>,
  todayDateKey: string,
): PendingItem[] {
  return items.filter((item) => dismissals[item.id] !== todayDateKey);
}
