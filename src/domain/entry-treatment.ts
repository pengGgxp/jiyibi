import type {
  ConfirmationStatus,
  EntryTreatment,
  LedgerEntry,
  RecoveryAllocation,
} from "./types";

const ENTRY_TREATMENTS: ReadonlySet<EntryTreatment> = new Set([
  "ordinary_expense",
  "periodic_expense",
  "one_time_expense",
  "reimbursable_expense",
  "ordinary_income",
  "refund_reimbursement",
  "account_transfer",
]);

const CONFIRMATION_STATUSES: ReadonlySet<ConfirmationStatus> = new Set([
  "not_needed",
  "pending",
  "confirmed",
]);

export function isEntryTreatment(value: unknown): value is EntryTreatment {
  return typeof value === "string" && ENTRY_TREATMENTS.has(value as EntryTreatment);
}

export function isConfirmationStatus(value: unknown): value is ConfirmationStatus {
  return typeof value === "string" && CONFIRMATION_STATUSES.has(value as ConfirmationStatus);
}

/** Conservative default from sign only — never infers transfer/refund/one-off. */
export function defaultTreatmentFromAmount(amountMinor: number): EntryTreatment {
  return amountMinor < 0 ? "ordinary_expense" : "ordinary_income";
}

export function treatmentMatchesAmount(
  treatment: EntryTreatment,
  amountMinor: number,
): boolean {
  if (treatment === "account_transfer") return amountMinor !== 0;
  if (
    treatment === "ordinary_expense"
    || treatment === "periodic_expense"
    || treatment === "one_time_expense"
    || treatment === "reimbursable_expense"
  ) {
    return amountMinor < 0;
  }
  return amountMinor > 0;
}

/**
 * Fill missing analysis fields for pre-v4 rows or remote v4 payloads.
 * Does not invent transfer/refund/one-off from notes or amounts.
 */
export function normalizeLedgerEntry(entry: LedgerEntry): LedgerEntry {
  const treatment = isEntryTreatment(entry.treatment)
    && treatmentMatchesAmount(entry.treatment, entry.amountMinor)
    ? entry.treatment
    : defaultTreatmentFromAmount(entry.amountMinor);
  const confirmationStatus = isConfirmationStatus(entry.confirmationStatus)
    ? entry.confirmationStatus
    : "not_needed";
  return {
    ...entry,
    treatment,
    confirmationStatus,
  };
}

/** Confirmed transfers are neutral for personal available funds. */
export function affectsBookBalance(entry: Pick<LedgerEntry, "treatment" | "deletedAt">): boolean {
  if (entry.deletedAt) return false;
  return entry.treatment !== "account_transfer";
}

/** External cashflow excludes confirmed transfers. */
export function affectsCashflow(entry: Pick<LedgerEntry, "treatment" | "deletedAt">): boolean {
  return affectsBookBalance(entry);
}

/**
 * Daily-spend baseline: ordinary expenses, and pending/unconfirmed negatives
 * that still use the conservative ordinary default.
 */
export function isDailySpendCandidate(
  entry: Pick<LedgerEntry, "amountMinor" | "treatment" | "deletedAt">,
): boolean {
  if (entry.deletedAt) return false;
  if (entry.amountMinor >= 0) return false;
  return entry.treatment === "ordinary_expense";
}

export function isRefundTreatment(treatment: EntryTreatment): boolean {
  return treatment === "refund_reimbursement";
}

export function isRecoverableExpenseTreatment(treatment: EntryTreatment): boolean {
  return (
    treatment === "ordinary_expense"
    || treatment === "periodic_expense"
    || treatment === "one_time_expense"
    || treatment === "reimbursable_expense"
  );
}

export class RecoveryAllocationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not-found"
      | "invalid-type"
      | "self-link"
      | "invalid-amount"
      | "over-allocated"
      | "deleted",
  ) {
    super(message);
    this.name = "RecoveryAllocationError";
  }
}

export interface RecoveryValidationContext {
  refund: LedgerEntry;
  expense: LedgerEntry;
  /** Other live allocations that already claim either side (excluding the one being saved). */
  existing: readonly RecoveryAllocation[];
  /** Allocation id being updated, if any — excluded from existing totals. */
  ignoreAllocationId?: string;
}

export function activeRecoveryAmount(
  allocations: readonly RecoveryAllocation[],
  predicate: (allocation: RecoveryAllocation) => boolean,
): number {
  let total = 0;
  for (const allocation of allocations) {
    if (allocation.deletedAt) continue;
    if (!predicate(allocation)) continue;
    if (!Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0) {
      throw new RangeError("recovery allocation must use positive safe integer minor units");
    }
    const next = total + allocation.amountMinor;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("recovery allocation total exceeds the safe integer range");
    }
    total = next;
  }
  return total;
}

/**
 * Validate a proposed recovery link. Does not mutate inputs.
 * Soft-deleted ends are rejected for new/updated links; callers stop counting
 * soft-deleted allocations without deleting the row during the undo window.
 */
export function assertRecoveryAllocationValid(
  amountMinor: number,
  context: RecoveryValidationContext,
): void {
  const { refund, expense, existing, ignoreAllocationId } = context;
  if (refund.deletedAt || expense.deletedAt) {
    throw new RecoveryAllocationError("已删除的账目不能建立恢复分摊", "deleted");
  }
  if (refund.id === expense.id) {
    throw new RecoveryAllocationError("恢复分摊不能关联同一条账目", "self-link");
  }
  if (refund.amountMinor <= 0 || !isRefundTreatment(refund.treatment)) {
    throw new RecoveryAllocationError("恢复流入必须是正金额的退款或报销", "invalid-type");
  }
  if (expense.amountMinor >= 0 || !isRecoverableExpenseTreatment(expense.treatment)) {
    throw new RecoveryAllocationError("只能把恢复金额分摊到支出账目", "invalid-type");
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new RecoveryAllocationError("分摊金额必须是正整数分", "invalid-amount");
  }

  const others = existing.filter(
    (allocation) => !allocation.deletedAt && allocation.id !== ignoreAllocationId,
  );
  const refundUsed = activeRecoveryAmount(
    others,
    (allocation) => allocation.refundEntryId === refund.id,
  );
  const expenseUsed = activeRecoveryAmount(
    others,
    (allocation) => allocation.expenseEntryId === expense.id,
  );
  const refundCap = refund.amountMinor;
  const expenseCap = Math.abs(expense.amountMinor);
  if (refundUsed + amountMinor > refundCap) {
    throw new RecoveryAllocationError("分摊合计不能超过退款或报销金额", "over-allocated");
  }
  if (expenseUsed + amountMinor > expenseCap) {
    throw new RecoveryAllocationError("分摊合计不能超过原始支出金额", "over-allocated");
  }
}

/** Net ordinary-expense analysis amount after live recovery allocations (≥ 0). */
export function ordinaryExpenseNetAnalysisMinor(
  expense: Pick<LedgerEntry, "id" | "amountMinor" | "treatment" | "deletedAt">,
  allocations: readonly RecoveryAllocation[],
): number {
  if (!isDailySpendCandidate(expense)) return 0;
  return netPersonalExpenseMinor(expense, allocations);
}

/** Amount of an expense that has not been covered by active recovery allocations. */
export function unrecoveredExpenseMinor(
  expense: Pick<LedgerEntry, "id" | "amountMinor" | "deletedAt">,
  allocations: readonly RecoveryAllocation[],
): number {
  if (expense.deletedAt || expense.amountMinor >= 0) return 0;
  const recovered = activeRecoveryAmount(
    allocations,
    (allocation) => allocation.expenseEntryId === expense.id,
  );
  const net = BigInt(-expense.amountMinor) - BigInt(recovered);
  if (net <= 0n) return 0;
  if (net > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("recovery amount exceeds the safe integer range");
  }
  return Number(net);
}

/**
 * Net expense personally borne after recovery. A still-open reimbursable
 * advance remains zero until the user closes it into a final treatment.
 */
export function netPersonalExpenseMinor(
  expense: Pick<LedgerEntry, "id" | "amountMinor" | "treatment" | "deletedAt">,
  allocations: readonly RecoveryAllocation[],
): number {
  if (expense.deletedAt || expense.amountMinor >= 0) return 0;
  if (
    expense.treatment !== "ordinary_expense"
    && expense.treatment !== "periodic_expense"
    && expense.treatment !== "one_time_expense"
  ) {
    return 0;
  }
  return unrecoveredExpenseMinor(expense, allocations);
}
