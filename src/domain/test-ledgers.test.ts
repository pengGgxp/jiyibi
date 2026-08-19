import { describe, expect, it } from "vitest";
import { calculateLedgerSummary, calculateSpendingAnalysis } from "./stats";
import {
  TEST_LEDGER_PLAN,
  testLedgers,
} from "./test-ledgers";
import type { IncomeForecast } from "./types";
import { resolveNextPaydayDateKey } from "./date";

function forecastFor(now: Date): IncomeForecast {
  return {
    id: "income-forecast",
    targetPaydayDateKey: resolveNextPaydayDateKey(TEST_LEDGER_PLAN.paydayDay, now),
    minimumIncomeMinor: 250_000,
    expectedIncomeMinor: 310_000,
  };
}

function analyze(ledger: (typeof testLedgers)[keyof typeof testLedgers]) {
  return calculateSpendingAnalysis(
    ledger.entries,
    ledger.balanceMinor,
    ledger.plan,
    forecastFor(ledger.now),
    ledger.now,
  );
}

describe("representative test ledgers (spec §7)", () => {
  it("stable daily spend reaches ready confidence over 30 days", () => {
    const analysis = analyze(testLedgers.stableDaily);
    expect(analysis.confidence).toBe("ready");
    expect(analysis.window.observedDays).toBe(30);
    expect(analysis.window.totalExpenseMinor).toBe(30_000);
    expect(analysis.window.averageDailyExpenseMinor).toBe(1_000);
    expect(analysis.currentCycle.affordability).toBeDefined();
  });

  it("floating income does not start the expense observation window", () => {
    const analysis = analyze(testLedgers.floatingIncome);
    expect(analysis.window.startDateKey).toBe("2026-07-12");
    expect(analysis.window.totalExpenseMinor).toBe(300);
    expect(analysis.dailyExpenses[0]).toEqual({ dateKey: "2026-07-12", expenseMinor: 100 });
  });

  it("a brand-new ledger stays insufficient under 14 completed days", () => {
    const analysis = analyze(testLedgers.justStarted);
    expect(analysis.confidence).toBe("insufficient");
    expect(analysis.window.observedDays).toBeLessThan(14);
    expect(analysis.currentCycle.affordability).toBeUndefined();
    expect(analysis.nextCycle.referenceSpendMinor).toBeUndefined();
  });

  it("income-only history never forms an expense forecast window", () => {
    const analysis = analyze(testLedgers.incomeOnly);
    expect(analysis.confidence).toBe("insufficient");
    expect(analysis.window.observedDays).toBe(0);
    expect(analysis.window.totalExpenseMinor).toBe(0);
    expect(analysis.dailyExpenses).toEqual([]);
  });

  it("MVP still folds a one-off large expense into the daily baseline", () => {
    const analysis = analyze(testLedgers.oneOffLargeExpense);
    expect(analysis.confidence).toBe("ready");
    // 29 * 500 + 50_000 — Layer 2 one_time treatment will drop the 50_000.
    expect(analysis.window.totalExpenseMinor).toBe(29 * 500 + 50_000);
  });

  it("same-day income and expense stay separate without auto-netting", () => {
    const analysis = analyze(testLedgers.sameDayInOut);
    const summary = calculateLedgerSummary(
      testLedgers.sameDayInOut.entries,
      { initialBalanceMinor: 0 },
      "2026-08",
    );
    // Same-day pair nets in balance; only the later -200 remains as net external flow.
    // Expense baseline still keeps the full 80_000 outflow (no auto-netting).
    expect(summary.balanceMinor).toBe(-200);
    expect(analysis.window.totalExpenseMinor).toBe(80_200);
    expect(analysis.dailyExpenses.find((day) => day.dateKey === "2026-07-12")?.expenseMinor)
      .toBe(80_000);
  });

  it("soft-deleted and future entries stay out of the baseline", () => {
    const analysis = analyze(testLedgers.deletedAndFuture);
    expect(analysis.window.startDateKey).toBe("2026-07-12");
    expect(analysis.window.totalExpenseMinor).toBe(300);
    // On the due date, the ending cycle still includes prior-cycle outflows and today.
    expect(analysis.currentCycle.actualExpenseMinor).toBe(700);
    expect(analysis.dailyExpenses.some((day) => day.expenseMinor === 50_000)).toBe(false);
    expect(analysis.dailyExpenses.some((day) => day.expenseMinor === 70_000)).toBe(false);
  });
});
