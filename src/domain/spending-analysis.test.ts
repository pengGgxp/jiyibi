import { describe, expect, it } from "vitest";
import { addLocalDays, localCalendarDayDifference, localDateFromKey } from "./date";
import { calculateSpendingAnalysis } from "./stats";
import type { LedgerEntry, PayCyclePlan } from "./types";

const DEFAULT_PLAN: PayCyclePlan = {
  paydayDay: 10,
  monthlySalaryMinor: 310_000,
  cycleEndBalanceGoalMinor: 50_000,
};

function entry(
  localDateKey: string,
  amountMinor: number,
  overrides: Partial<LedgerEntry> = {},
): LedgerEntry {
  return {
    id: `${localDateKey}-${amountMinor}`,
    amountMinor,
    note: "test entry",
    occurredAt: `${localDateKey}T04:00:00.000Z`,
    localDateKey,
    localMonthKey: localDateKey.slice(0, 7),
    timezoneOffsetMinutes: -480,
    createdAt: `${localDateKey}T04:00:00.000Z`,
    updatedAt: `${localDateKey}T04:00:00.000Z`,
    ...overrides,
  };
}

describe("local calendar date helpers", () => {
  it("moves through leap days and compares calendar dates without elapsed-hour math", () => {
    expect(addLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addLocalDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(localCalendarDayDifference("2028-02-28", "2028-03-01")).toBe(2);
  });

  it("rejects malformed and impossible local date keys", () => {
    expect(() => localDateFromKey("2026-2-01")).toThrow();
    expect(() => localDateFromKey("2026-02-30")).toThrow();
  });
});

describe("spending forecast confidence", () => {
  it.each([
    [13, "insufficient"],
    [14, "preliminary"],
    [29, "preliminary"],
    [30, "ready"],
  ] as const)("uses %i completed days as %s confidence", (observedDays, confidence) => {
    const yesterday = "2026-08-09";
    const firstDate = addLocalDays(yesterday, -(observedDays - 1));
    const analysis = calculateSpendingAnalysis(
      [entry(firstDate, -1_400)],
      100_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );

    expect(analysis.confidence).toBe(confidence);
    expect(analysis.window).toMatchObject({
      startDateKey: firstDate,
      endDateKey: yesterday,
      observedDays,
      daysNeeded: 14,
    });
    if (observedDays < 14) {
      expect(analysis.currentCycle.estimatedRemainingExpenseMinor).toBeUndefined();
      expect(analysis.currentCycle.affordability).toBeUndefined();
      expect(analysis.nextCycle.estimatedExpenseMinor).toBeUndefined();
      expect(analysis.nextCycle.affordability).toBeUndefined();
    } else {
      expect(analysis.currentCycle.estimatedRemainingExpenseMinor).toBeDefined();
      expect(analysis.nextCycle.estimatedExpenseMinor).toBeDefined();
    }
  });

  it("has no forecast window before the first completed local day", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-08-10", -100), entry("2026-08-11", -200)],
      10_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );

    expect(analysis.confidence).toBe("insufficient");
    expect(analysis.window).toEqual({
      endDateKey: "2026-08-09",
      observedDays: 0,
      daysNeeded: 14,
      totalExpenseMinor: 0,
    });
    expect(analysis.dailyExpenses).toEqual([]);
  });
});

describe("spending forecast inputs", () => {
  it("counts zero-spend dates while excluding income, deleted entries, and future entries", () => {
    const analysis = calculateSpendingAnalysis(
      [
        entry("2026-07-11", 99_999, { id: "window-starting-income" }),
        entry("2026-07-12", -100),
        entry("2026-07-13", -50_000, { deletedAt: "2026-07-14T00:00:00.000Z" }),
        entry("2026-08-09", -200),
        entry("2026-08-10", -400, { id: "today" }),
        entry("2026-08-11", -70_000, { id: "future" }),
      ],
      100_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );

    expect(analysis.confidence).toBe("ready");
    expect(analysis.window).toMatchObject({
      observedDays: 30,
      totalExpenseMinor: 300,
      averageDailyExpenseMinor: 10,
    });
    expect(analysis.dailyExpenses).toHaveLength(30);
    expect(analysis.dailyExpenses[0]).toEqual({ dateKey: "2026-07-11", expenseMinor: 0 });
    expect(analysis.dailyExpenses[2]).toEqual({ dateKey: "2026-07-13", expenseMinor: 0 });
    expect(analysis.dailyExpenses.at(-1)).toEqual({ dateKey: "2026-08-09", expenseMinor: 200 });
    expect(analysis.currentCycle.actualExpenseMinor).toBe(400);
  });

  it("rounds scaled forecasts once with BigInt half-up arithmetic", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-26", -7)],
      100,
      { ...DEFAULT_PLAN, cycleEndBalanceGoalMinor: 99 },
      new Date(2026, 7, 9, 23, 59),
    );

    expect(analysis.window).toMatchObject({
      observedDays: 14,
      totalExpenseMinor: 7,
      averageDailyExpenseMinor: 1,
    });
    // Today is conservatively counted as one complete remaining spending day.
    expect(analysis.currentCycle.daysUntilPayday).toBe(1);
    expect(analysis.currentCycle.estimatedRemainingExpenseMinor).toBe(1);
    expect(analysis.currentCycle.projectedEndBalanceMinor).toBe(99n);
    expect(analysis.currentCycle.balanceGoalDifferenceMinor).toBe(0n);
    expect(analysis.currentCycle.affordability).toBe("exact");
    // 7 * 31 / 14 = 15.5, rounded once to 16 rather than using rounded daily spend.
    expect(analysis.nextCycle.days).toBe(31);
    expect(analysis.nextCycle.estimatedExpenseMinor).toBe(16);
  });

  it.each([
    [1_100, "exact", 0n],
    [1_101, "surplus", 1n],
    [1_099, "shortfall", -1n],
  ] as const)("classifies a projected balance of %i as %s", (balance, affordability, difference) => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-26", -1_400)],
      balance,
      { ...DEFAULT_PLAN, cycleEndBalanceGoalMinor: 1_000 },
      new Date(2026, 7, 9, 12),
    );
    expect(analysis.currentCycle.estimatedRemainingExpenseMinor).toBe(100);
    expect(analysis.currentCycle.balanceGoalDifferenceMinor).toBe(difference);
    expect(analysis.currentCycle.affordability).toBe(affordability);
  });

  it.each([
    [3_100, "exact", 0n],
    [3_101, "surplus", 1n],
    [3_099, "shortfall", -1n],
  ] as const)("classifies a next-cycle salary of %i as %s", (salary, affordability, difference) => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-26", -1_400)],
      100_000,
      { ...DEFAULT_PLAN, monthlySalaryMinor: salary },
      new Date(2026, 7, 9, 12),
    );
    expect(analysis.nextCycle.estimatedExpenseMinor).toBe(3_100);
    expect(analysis.nextCycle.salaryDifferenceMinor).toBe(difference);
    expect(analysis.nextCycle.affordability).toBe(affordability);
  });

  it("reports a negative balance shortfall and never exposes negative safe spending", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-26", 100)],
      -1_000,
      { ...DEFAULT_PLAN, cycleEndBalanceGoalMinor: 0 },
      new Date(2026, 7, 9, 12),
    );

    expect(analysis.currentCycle.projectedEndBalanceMinor).toBe(-1_000n);
    expect(analysis.currentCycle.balanceGoalDifferenceMinor).toBe(-1_000n);
    expect(analysis.currentCycle.affordability).toBe("shortfall");
    expect(analysis.currentCycle.safeToSpendMinor).toBe(0n);
    expect(analysis.currentCycle.dailySafeToSpendMinor).toBe(0n);
  });

  it("floors the current safe-to-spend amount into whole minor units per day", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-11", 100)],
      51_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );
    expect(analysis.currentCycle.daysUntilPayday).toBe(31);
    expect(analysis.currentCycle.safeToSpendMinor).toBe(1_000n);
    expect(analysis.currentCycle.dailySafeToSpendMinor).toBe(32n);
  });

  it("keeps balance differences exact when two safe inputs exceed number range", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-26", 1)],
      Number.MIN_SAFE_INTEGER,
      { ...DEFAULT_PLAN, cycleEndBalanceGoalMinor: Number.MAX_SAFE_INTEGER },
      new Date(2026, 7, 9, 12),
    );
    expect(analysis.currentCycle.balanceHeadroomMinor).toBe(-18_014_398_509_481_982n);
    expect(analysis.currentCycle.balanceGoalDifferenceMinor).toBe(-18_014_398_509_481_982n);
  });

  it("rejects a forecast that would exceed the safe integer range", () => {
    expect(() => calculateSpendingAnalysis(
      [entry("2026-07-26", -Number.MAX_SAFE_INTEGER)],
      0,
      DEFAULT_PLAN,
      new Date(2026, 7, 9, 12),
    )).toThrow("预测支出超出安全范围");
  });
});

describe("spending chart series", () => {
  it("builds the complete daily, cumulative, and six-cycle series", () => {
    const analysis = calculateSpendingAnalysis(
      [
        entry("2026-01-10", 1, { id: "observation-start" }),
        entry("2026-07-11", -3_000),
        entry("2026-08-10", -500, { id: "today" }),
      ],
      100_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );

    expect(analysis.dailyExpenses).toHaveLength(30);
    expect(analysis.dailyExpenses[0]).toEqual({ dateKey: "2026-07-11", expenseMinor: 3_000 });
    expect(analysis.dailyExpenses.slice(1).every((point) => point.expenseMinor === 0)).toBe(true);

    expect(analysis.currentCycle.actualExpenseMinor).toBe(500);
    expect(analysis.currentCycle.estimatedRemainingExpenseMinor).toBe(3_100);
    expect(analysis.currentCycleSeries).toHaveLength(32);
    expect(analysis.currentCycleSeries[0]).toEqual({
      dateKey: "2026-08-10",
      actualCumulativeMinor: 500,
      projectedCumulativeMinor: 500,
      isPaydayBoundary: false,
    });
    expect(analysis.currentCycleSeries.at(-1)).toEqual({
      dateKey: "2026-09-10",
      projectedCumulativeMinor: 3_600,
      isPaydayBoundary: true,
    });

    expect(analysis.completedCycles).toHaveLength(6);
    expect(analysis.completedCycles.at(-1)).toMatchObject({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      dayCount: 31,
      expenseMinor: 3_000,
    });
    expect(analysis.completedCycles.slice(0, -1).every((cycle) => cycle.expenseMinor === 0))
      .toBe(true);
  });

  it("does not fabricate zero-spend cycles before the first observed date", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2026-07-11", -3_000)],
      100_000,
      DEFAULT_PLAN,
      new Date(2026, 7, 10, 12),
    );

    // The entry is in the middle of the Jul 10-Aug 9 cycle, so that cycle is
    // partial and no complete historical cycle is known yet.
    expect(analysis.completedCycles).toEqual([]);
  });

  it("uses clamped payday boundaries to derive the next full cycle length", () => {
    const analysis = calculateSpendingAnalysis(
      [entry("2028-01-30", -3_000)],
      100_000,
      { ...DEFAULT_PLAN, paydayDay: 31 },
      new Date(2028, 1, 29, 12),
    );

    expect(analysis.currentCycle).toMatchObject({
      cycleStartDateKey: "2028-02-29",
      cycleEndDateKey: "2028-03-30",
      nextPaydayDateKey: "2028-03-31",
      daysUntilPayday: 31,
    });
    expect(analysis.nextCycle).toMatchObject({
      cycleStartDateKey: "2028-03-31",
      cycleEndDateKey: "2028-04-29",
      nextPaydayDateKey: "2028-04-30",
      days: 30,
    });
  });
});
