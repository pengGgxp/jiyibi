import { describe, expect, it } from "vitest";
import {
  EXCEPTION_ABSOLUTE_MINOR,
  INCOME_EXCEPTION_ABSOLUTE_MINOR,
  evaluateExceptionPrompt,
  expensePromptThresholdMinor,
  expenseTreatmentOptions,
  incomeTreatmentOptions,
} from "./exception-prompt";
import { testEntry, TEST_LEDGER_NOW, TEST_LEDGER_PLAN } from "./test-ledgers";
import { calculateSpendingAnalysis } from "./stats";
import type { IncomeForecast, SpendingAnalysis } from "./types";
import { resolveNextPaydayDateKey } from "./date";
import { addLocalDays } from "./date";

function forecast(): IncomeForecast {
  return {
    id: "f",
    targetPaydayDateKey: resolveNextPaydayDateKey(TEST_LEDGER_PLAN.paydayDay, TEST_LEDGER_NOW),
    minimumIncomeMinor: 100_000,
    expectedIncomeMinor: 100_000,
  };
}

function analysisFor(entries: ReturnType<typeof testEntry>[]): SpendingAnalysis {
  return calculateSpendingAnalysis(
    entries,
    100_000,
    TEST_LEDGER_PLAN,
    forecast(),
    TEST_LEDGER_NOW,
  );
}

function thresholdAnalysis(overrides: Partial<SpendingAnalysis> = {}): SpendingAnalysis {
  const base = analysisFor([]);
  return {
    ...base,
    window: {
      ...base.window,
      observedDays: 20,
      daysNeeded: 14,
      totalExpenseMinor: 100_000,
      averageDailyExpenseMinor: 5_000,
    },
    ...overrides,
  };
}

describe("evaluateExceptionPrompt", () => {
  it("does not offer account transfers as a treatment", () => {
    expect(expenseTreatmentOptions().map((option) => option.value))
      .not.toContain("account_transfer");
    expect(incomeTreatmentOptions().map((option) => option.value))
      .not.toContain("account_transfer");
  });

  it("does not prompt ordinary small expenses", () => {
    const history = Array.from({ length: 20 }, (_, index) => (
      testEntry(addLocalDays("2026-07-20", index), -1_000)
    ));
    const small = testEntry("2026-08-10", -1_200, { id: "small" });
    const decision = evaluateExceptionPrompt(
      small,
      [...history, small],
      analysisFor([...history, small]),
    );
    expect(decision.shouldPrompt).toBe(false);
  });

  it("prompts a large one-off style expense against a stable baseline", () => {
    const history = Array.from({ length: 20 }, (_, index) => (
      testEntry(addLocalDays("2026-07-20", index), -1_000)
    ));
    const large = testEntry("2026-08-10", -80_000, { id: "large" });
    const decision = evaluateExceptionPrompt(
      large,
      [...history, large],
      analysisFor(history),
    );
    expect(decision.shouldPrompt).toBe(true);
    expect(decision.kind).toBe("expense");
    expect(decision.reasons).toContain("large_expense");
  });

  it("prompts income that matches a recent expense magnitude", () => {
    const expense = testEntry("2026-07-15", -12_345, { id: "exp" });
    const refund = testEntry("2026-08-01", 12_345, { id: "ref" });
    const decision = evaluateExceptionPrompt(refund, [expense, refund], undefined);
    expect(decision.shouldPrompt).toBe(true);
    expect(decision.kind).toBe("income");
    expect(decision.reasons).toContain("possible_refund");
  });

  it("skips when this revision was already prompted", () => {
    const large = testEntry("2026-08-10", -80_000, {
      id: "large",
      confirmationStatus: "pending",
      promptedRevision: "2026-08-10T04:00:00.000Z",
      updatedAt: "2026-08-10T04:00:00.000Z",
    });
    const decision = evaluateExceptionPrompt(large, [large], undefined);
    expect(decision.shouldPrompt).toBe(false);
  });

  it("does not apply the new threshold to a legacy row", () => {
    const legacy = testEntry("2026-08-10", -80_000, {
      id: "legacy",
      detectionRuleVersion: 1,
    });
    expect(evaluateExceptionPrompt(legacy, [legacy], undefined).shouldPrompt).toBe(false);
  });

  it.each([
    [EXCEPTION_ABSOLUTE_MINOR - 1, false],
    [EXCEPTION_ABSOLUTE_MINOR, true],
    [EXCEPTION_ABSOLUTE_MINOR + 1, true],
  ])("uses the inclusive absolute threshold for sparse history: %i", (amount, expected) => {
    const expense = testEntry("2026-08-10", -amount, { id: `expense-${amount}` });
    const decision = evaluateExceptionPrompt(expense, [expense], undefined);
    expect(decision.reasons.includes("large_expense")).toBe(expected);
  });

  it.each([
    [29_999, false],
    [30_000, true],
    [30_001, true],
  ])("uses three completed-day averages after 14 days: %i", (amount, expected) => {
    const expense = testEntry("2026-08-10", -amount, { id: `expense-${amount}` });
    const analysis = thresholdAnalysis({
      window: {
        endDateKey: "2026-08-09",
        observedDays: 20,
        daysNeeded: 14,
        totalExpenseMinor: 200_000,
        averageDailyExpenseMinor: 10_000,
      },
    });
    const decision = evaluateExceptionPrompt(expense, [expense], analysis);
    expect(decision.reasons.includes("large_expense")).toBe(expected);
  });

  it.each([
    [29_999, false],
    [30_000, true],
  ])("derives the dynamic threshold without a pay-cycle plan: %i", (amount, expected) => {
    const history = Array.from({ length: 14 }, (_, index) => (
      testEntry(addLocalDays("2026-07-27", index), -10_000, { id: `history-${index}` })
    ));
    const expense = testEntry("2026-08-10", -amount, { id: `expense-${amount}` });
    const decision = evaluateExceptionPrompt(
      expense,
      [...history, expense],
      undefined,
      [],
      TEST_LEDGER_NOW,
    );
    expect(decision.reasons.includes("large_expense")).toBe(expected);
  });

  it.each([
    [INCOME_EXCEPTION_ABSOLUTE_MINOR - 1, false],
    [INCOME_EXCEPTION_ABSOLUTE_MINOR, true],
  ])("keeps the inclusive CNY 500 income threshold: %i", (amount, expected) => {
    const income = testEntry("2026-08-10", amount, { id: `income-${amount}` });
    expect(evaluateExceptionPrompt(income, [income], undefined).reasons.includes("large_income"))
      .toBe(expected);
  });

  it("uses the absolute threshold before 14 completed days", () => {
    const expense = testEntry("2026-08-10", -20_000, { id: "sparse" });
    const analysis = thresholdAnalysis({
      window: {
        endDateKey: "2026-08-09",
        observedDays: 13,
        daysNeeded: 14,
        totalExpenseMinor: 1_300_000,
        averageDailyExpenseMinor: 100_000,
      },
    });
    expect(evaluateExceptionPrompt(expense, [expense], analysis).reasons)
      .toContain("large_expense");
  });

  it("rounds a fractional dynamic threshold up to the next cent", () => {
    const analysis = thresholdAnalysis({
      window: {
        endDateKey: "2026-08-09",
        observedDays: 20,
        daysNeeded: 14,
        totalExpenseMinor: 200_001,
        averageDailyExpenseMinor: 10_000,
      },
    });
    expect(expensePromptThresholdMinor(analysis)).toBe(30_001);
  });

  it("prompts when excluding the expense would reverse a shortfall", () => {
    const expense = testEntry("2026-08-10", -19_999, { id: "flip" });
    const base = thresholdAnalysis();
    const analysis: SpendingAnalysis = {
      ...base,
      currentCycle: {
        ...base.currentCycle,
        affordability: "shortfall",
        estimatedRemainingExpenseMinor: 100_000,
        balanceGoalDifferenceMinor: -15_000n,
      },
    };
    const decision = evaluateExceptionPrompt(expense, [expense], analysis);
    expect(decision.reasons).toContain("flips_affordability");
    expect(decision.reasons).not.toContain("large_expense");
  });

  it.each([
    [99, true],
    [100, true],
    [101, false],
  ])("uses an inclusive one-yuan refund tolerance: %i", (difference, expected) => {
    const expense = testEntry("2026-07-15", -12_345, { id: "expense" });
    const refund = testEntry("2026-08-01", 12_345 + difference, { id: "refund" });
    const decision = evaluateExceptionPrompt(refund, [expense, refund], undefined);
    expect(decision.reasons.includes("possible_refund")).toBe(expected);
  });

  it.each([
    [59, true],
    [60, true],
    [61, false],
  ])("uses an inclusive sixty-day refund lookback: %i", (days, expected) => {
    const refund = testEntry("2026-08-10", 12_345, { id: "refund" });
    const expenseDate = addLocalDays("2026-08-10", -days);
    const expense = testEntry(expenseDate, -12_345, { id: `expense-${days}` });
    const decision = evaluateExceptionPrompt(refund, [refund, expense], undefined);
    expect(decision.reasons.includes("possible_refund")).toBe(expected);
  });

  it("ignores deleted, future and later-listed refund candidates", () => {
    const refund = testEntry("2026-08-10", 12_345, { id: "refund" });
    const deleted = testEntry("2026-08-01", -12_345, {
      id: "deleted",
      deletedAt: "2026-08-02T04:00:00.000Z",
    });
    const future = testEntry("2026-08-11", -12_345, { id: "future" });
    const decision = evaluateExceptionPrompt(refund, [future, refund, deleted], undefined);
    expect(decision.reasons).not.toContain("possible_refund");
  });

  it("does not depend on same-day entry order", () => {
    const expense = testEntry("2026-08-01", -12_345, {
      id: "expense",
      occurredAt: "2026-08-01T03:00:00.000Z",
    });
    const refund = testEntry("2026-08-01", 12_345, {
      id: "refund",
      occurredAt: "2026-08-01T04:00:00.000Z",
    });
    const forward = evaluateExceptionPrompt(refund, [expense, refund], undefined);
    const reverse = evaluateExceptionPrompt(refund, [refund, expense], undefined);
    expect(forward).toEqual(reverse);
    expect(forward.reasons).toContain("possible_refund");
  });
});
