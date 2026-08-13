import { addLocalDays } from "./date";
import type { LedgerEntry, PayCyclePlan } from "./types";

/** Shared pay-cycle plan for representative test ledgers. */
export const TEST_LEDGER_PLAN: PayCyclePlan = {
  paydayDay: 10,
  cycleEndBalanceGoalMinor: 50_000,
};

/** Anchor "today" used by fixtures: 2026-08-10 local noon. */
export const TEST_LEDGER_NOW = new Date(2026, 7, 10, 12);

export function testEntry(
  localDateKey: string,
  amountMinor: number,
  overrides: Partial<LedgerEntry> = {},
): LedgerEntry {
  return {
    id: overrides.id ?? `${localDateKey}-${amountMinor}`,
    amountMinor,
    note: overrides.note ?? "test entry",
    occurredAt: overrides.occurredAt ?? `${localDateKey}T04:00:00.000Z`,
    localDateKey,
    localMonthKey: localDateKey.slice(0, 7),
    timezoneOffsetMinutes: overrides.timezoneOffsetMinutes ?? -480,
    createdAt: overrides.createdAt ?? `${localDateKey}T04:00:00.000Z`,
    updatedAt: overrides.updatedAt ?? `${localDateKey}T04:00:00.000Z`,
    ...overrides,
  };
}

function dailyExpenses(
  firstDateKey: string,
  dayCount: number,
  amountMinor: number,
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    entries.push(testEntry(addLocalDays(firstDateKey, offset), -amountMinor));
  }
  return entries;
}

/**
 * Spec §7 scenes as pure data. Expectation comments document current MVP
 * rules (all negatives enter daily spend) and the P0 window rule (income
 * does not open coverage). Layer 2 will re-assert treatment-aware outcomes.
 */
export const testLedgers = {
  /** Stable daily spend across a full 30-day window. */
  stableDaily: {
    // Expect: confidence ready; window 30 days; total 30 * 1000.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 100_000,
    entries: dailyExpenses("2026-07-11", 30, 1_000),
  },

  /** Floating income does not open or dilute the expense window. */
  floatingIncome: {
    // Expect: window starts 2026-07-12 (first expense); income ignored for coverage.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 200_000,
    entries: [
      testEntry("2026-07-05", 800_000, { id: "salary", note: "工资" }),
      testEntry("2026-07-12", -100),
      testEntry("2026-08-09", -200),
      testEntry("2026-08-10", 50_000, { id: "bonus", note: "奖金" }),
    ],
  },

  /** Brand-new ledger with fewer than 14 completed expense days. */
  justStarted: {
    // Expect: confidence insufficient; no affordability verdict.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 80_000,
    entries: dailyExpenses("2026-08-03", 7, 2_000),
  },

  /** Income-only history must not form an expense forecast window. */
  incomeOnly: {
    // Expect: observedDays 0; confidence insufficient; empty daily series.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 150_000,
    entries: [
      testEntry("2026-07-11", 99_999, { id: "salary" }),
      testEntry("2026-08-01", 50_000, { id: "bonus" }),
    ],
  },

  /** One large expense mixed with small daily spend (MVP still includes it). */
  oneOffLargeExpense: {
    // Expect MVP: large expense counted in baseline total.
    // Layer 2 one_time_expense will exclude it from daily spend only.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 100_000,
    entries: [
      ...dailyExpenses("2026-07-11", 29, 500),
      testEntry("2026-08-09", -50_000, { id: "device", note: "设备" }),
    ],
  },

  /** Same-day large income and expense stay separate; no auto-netting. */
  sameDayInOut: {
    // Expect: expense window includes the outflow; income does not cancel it.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 100_000,
    entries: [
      testEntry("2026-07-12", 80_000, { id: "in" }),
      testEntry("2026-07-12", -80_000, { id: "out" }),
      testEntry("2026-08-09", -200),
    ],
  },

  /** Soft-deleted and future entries must not enter the baseline. */
  deletedAndFuture: {
    // Expect: only the live past expense counts; deleted/future ignored.
    now: TEST_LEDGER_NOW,
    plan: TEST_LEDGER_PLAN,
    balanceMinor: 100_000,
    entries: [
      testEntry("2026-07-12", -100),
      testEntry("2026-07-13", -50_000, {
        id: "deleted",
        deletedAt: "2026-07-14T00:00:00.000Z",
      }),
      testEntry("2026-08-09", -200),
      testEntry("2026-08-10", -400, { id: "today" }),
      testEntry("2026-08-11", -70_000, { id: "future" }),
    ],
  },
} as const;

export type TestLedgerName = keyof typeof testLedgers;
