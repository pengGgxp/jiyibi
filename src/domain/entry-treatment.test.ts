import { describe, expect, it } from "vitest";
import {
  activeRecoveryAmount,
  assertRecoveryAllocationValid,
  defaultTreatmentFromAmount,
  isDailySpendCandidate,
  normalizeLedgerEntry,
  ordinaryExpenseNetAnalysisMinor,
  RecoveryAllocationError,
  treatmentMatchesAmount,
} from "./entry-treatment";
import type { LedgerEntry, RecoveryAllocation } from "./types";

function entry(overrides: Partial<LedgerEntry> & Pick<LedgerEntry, "amountMinor">): LedgerEntry {
  const amountMinor = overrides.amountMinor;
  return {
    id: "entry-1",
    note: "test",
    occurredAt: "2026-07-30T04:00:00.000Z",
    localDateKey: "2026-07-30",
    localMonthKey: "2026-07",
    timezoneOffsetMinutes: -480,
    treatment: amountMinor < 0 ? "ordinary_expense" : "ordinary_income",
    confirmationStatus: "not_needed",
    createdAt: "2026-07-30T04:00:00.000Z",
    updatedAt: "2026-07-30T04:00:00.000Z",
    ...overrides,
  };
}

function allocation(overrides: Partial<RecoveryAllocation> = {}): RecoveryAllocation {
  return {
    id: "alloc-1",
    refundEntryId: "refund-1",
    expenseEntryId: "expense-1",
    amountMinor: 100,
    createdAt: "2026-07-30T04:00:00.000Z",
    updatedAt: "2026-07-30T04:00:00.000Z",
    ...overrides,
  };
}

describe("entry treatment defaults", () => {
  it("maps sign to ordinary income or expense only", () => {
    expect(defaultTreatmentFromAmount(-1)).toBe("ordinary_expense");
    expect(defaultTreatmentFromAmount(1)).toBe("ordinary_income");
  });

  it("rejects treatment that conflicts with amount sign", () => {
    expect(treatmentMatchesAmount("ordinary_expense", -100)).toBe(true);
    expect(treatmentMatchesAmount("ordinary_expense", 100)).toBe(false);
    expect(treatmentMatchesAmount("ordinary_income", 100)).toBe(true);
    expect(treatmentMatchesAmount("refund_reimbursement", -100)).toBe(false);
    expect(treatmentMatchesAmount("account_transfer", -50)).toBe(true);
  });

  it("normalizes missing fields without inventing one-off or transfer", () => {
    const raw = entry({ amountMinor: -500 }) as LedgerEntry & {
      treatment?: LedgerEntry["treatment"];
    };
    delete (raw as { treatment?: string }).treatment;
    delete (raw as { confirmationStatus?: string }).confirmationStatus;
    const normalized = normalizeLedgerEntry(raw);
    expect(normalized.treatment).toBe("ordinary_expense");
    expect(normalized.confirmationStatus).toBe("not_needed");
  });

  it("only ordinary expenses are daily-spend candidates", () => {
    expect(isDailySpendCandidate(entry({ amountMinor: -100 }))).toBe(true);
    expect(isDailySpendCandidate(entry({
      amountMinor: -100,
      treatment: "one_time_expense",
    }))).toBe(false);
    expect(isDailySpendCandidate(entry({ amountMinor: 100 }))).toBe(false);
    expect(isDailySpendCandidate(entry({
      amountMinor: -100,
      deletedAt: "2026-07-31T00:00:00.000Z",
    }))).toBe(false);
  });
});

describe("recovery allocations", () => {
  const refund = entry({
    id: "refund-1",
    amountMinor: 1_000,
    treatment: "refund_reimbursement",
  });
  const expense = entry({
    id: "expense-1",
    amountMinor: -800,
    treatment: "ordinary_expense",
  });

  it("accepts a partial recovery within both caps", () => {
    expect(() => assertRecoveryAllocationValid(300, {
      refund,
      expense,
      existing: [],
    })).not.toThrow();
  });

  it("rejects over-allocation on either side", () => {
    expect(() => assertRecoveryAllocationValid(900, {
      refund,
      expense,
      existing: [],
    })).toThrow(RecoveryAllocationError);

    expect(() => assertRecoveryAllocationValid(700, {
      refund,
      expense,
      existing: [allocation({ amountMinor: 200 })],
    })).toThrow(/原始支出/);
  });

  it("rejects self-links and wrong directions", () => {
    expect(() => assertRecoveryAllocationValid(100, {
      refund,
      expense: refund,
      existing: [],
    })).toThrow(/同一条/);

    expect(() => assertRecoveryAllocationValid(100, {
      refund: entry({ id: "in", amountMinor: 500, treatment: "ordinary_income" }),
      expense,
      existing: [],
    })).toThrow(/退款或报销/);
  });

  it("ignores soft-deleted allocations in active totals", () => {
    const total = activeRecoveryAmount(
      [
        allocation({ amountMinor: 200 }),
        allocation({ id: "gone", amountMinor: 500, deletedAt: "2026-08-01T00:00:00.000Z" }),
      ],
      (item) => item.expenseEntryId === "expense-1",
    );
    expect(total).toBe(200);
  });

  it("computes ordinary expense net analysis amount after recovery", () => {
    expect(ordinaryExpenseNetAnalysisMinor(expense, [
      allocation({ amountMinor: 300 }),
    ])).toBe(500);
    expect(ordinaryExpenseNetAnalysisMinor(expense, [
      allocation({ amountMinor: 800 }),
    ])).toBe(0);
    expect(ordinaryExpenseNetAnalysisMinor(
      entry({ amountMinor: -100, treatment: "one_time_expense" }),
      [allocation({ amountMinor: 50, expenseEntryId: "entry-1" })],
    )).toBe(0);
  });
});
