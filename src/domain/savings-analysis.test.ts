import { describe, expect, it } from "vitest";
import {
  calculateCycleSavingsProgress,
  calculateRetainedSavingsSummary,
  calculateSavingsHistory,
  calculateSpendingAnalysis,
} from "./stats";
import type {
  IncomeForecast,
  LedgerEntry,
  PayCyclePlan,
  SavingsEvent,
} from "./types";

const SAVINGS_PLAN: PayCyclePlan = {
  paydayDay: 10,
  defaultSavingsTargetMinor: 3_000,
};

function savingsEvent(
  id: string,
  kind: "opening" | "reserve" | "release",
  amountMinor: number,
  localDateKey: string,
  overrides: Partial<SavingsEvent> = {},
): SavingsEvent {
  return {
    id,
    kind,
    amountMinor,
    note: "test savings event",
    occurredAt: `${localDateKey}T04:00:00.000Z`,
    localDateKey,
    localMonthKey: localDateKey.slice(0, 7),
    timezoneOffsetMinutes: -480,
    createdAt: `${localDateKey}T04:00:00.000Z`,
    updatedAt: `${localDateKey}T04:00:00.000Z`,
    ...overrides,
  } as SavingsEvent;
}

function settlement(
  cycleStartDateKey: string,
  cycleEndDateKey: string,
  amountMinor: number,
  id = `settlement-${cycleStartDateKey}`,
  recordedDateKey = cycleEndDateKey,
): SavingsEvent {
  return {
    ...savingsEvent(id, "reserve", amountMinor || 1, recordedDateKey),
    kind: "cycle_settlement",
    amountMinor,
    cycleStartDateKey,
    cycleEndDateKey,
    goalMinorSnapshot: 3_000,
    openingRetainedMinor: 10_000,
    closingRetainedMinor: 10_000 + amountMinor,
    netGrowthMinor: amountMinor,
  } as SavingsEvent;
}

function expense(localDateKey: string, amountMinor: number): LedgerEntry {
  return {
    id: `expense-${localDateKey}`,
    amountMinor,
    note: "test expense",
    occurredAt: `${localDateKey}T04:00:00.000Z`,
    localDateKey,
    localMonthKey: localDateKey.slice(0, 7),
    timezoneOffsetMinutes: -480,
    treatment: "ordinary_expense",
    confirmationStatus: "not_needed",
    createdAt: `${localDateKey}T04:00:00.000Z`,
    updatedAt: `${localDateKey}T04:00:00.000Z`,
  };
}

function forecast(overrides: Partial<IncomeForecast> = {}): IncomeForecast {
  return {
    id: "forecast-1",
    targetPaydayDateKey: "2026-08-10",
    minimumIncomeMinor: 4_100,
    expectedIncomeMinor: 5_000,
    ...overrides,
  };
}

describe("retained savings totals", () => {
  it("folds opening, reserve, release, and settlement without using number addition", () => {
    const summary = calculateRetainedSavingsSummary([
      savingsEvent("opening", "opening", Number.MAX_SAFE_INTEGER, "2026-07-01"),
      savingsEvent("reserve", "reserve", Number.MAX_SAFE_INTEGER, "2026-07-02"),
      savingsEvent("release", "release", 500, "2026-07-03"),
      settlement("2026-07-10", "2026-08-09", 250),
      savingsEvent("deleted", "reserve", 99_999, "2026-07-04", {
        deletedAt: "2026-07-05T00:00:00.000Z",
      }),
    ]);

    expect(summary).toMatchObject({
      openingRetainedMinor: BigInt(Number.MAX_SAFE_INTEGER),
      reservedMinor: BigInt(Number.MAX_SAFE_INTEGER),
      releasedMinor: 500n,
      settledMinor: 250n,
      totalRetainedMinor: 18_014_398_509_481_732n,
      hasNegativeBalance: false,
      needsCorrection: false,
    });
  });

  it("marks concurrent releases below zero for correction instead of truncating", () => {
    const summary = calculateRetainedSavingsSummary([
      savingsEvent("opening", "opening", 1_000, "2026-07-01"),
      savingsEvent("release-a", "release", 800, "2026-07-02"),
      savingsEvent("release-b", "release", 800, "2026-07-02"),
    ]);

    expect(summary.totalRetainedMinor).toBe(-600n);
    expect(summary.hasNegativeBalance).toBe(true);
    expect(summary.needsCorrection).toBe(true);
  });

  it("keeps duplicate opening amounts visible but marks them for correction", () => {
    const summary = calculateRetainedSavingsSummary([
      savingsEvent("opening-a", "opening", 1_000, "2026-07-01"),
      savingsEvent("opening-b", "opening", 500, "2026-07-02"),
    ]);

    expect(summary.openingRetainedMinor).toBe(1_500n);
    expect(summary.totalRetainedMinor).toBe(1_500n);
    expect(summary.needsCorrection).toBe(true);
  });

  it("accepts a zero settlement and flags duplicate live settlements", () => {
    const summary = calculateRetainedSavingsSummary([
      settlement("2026-07-10", "2026-08-09", 0, "settlement-a"),
      settlement("2026-07-10", "2026-08-09", 0, "settlement-b"),
    ]);

    expect(summary.totalRetainedMinor).toBe(0n);
    expect(summary.needsCorrection).toBe(true);
  });
});

describe("cycle savings progress", () => {
  it("treats a mid-cycle opening amount as the baseline, not new savings", () => {
    const progress = calculateCycleSavingsProgress(
      [
        savingsEvent("opening", "opening", 5_000, "2026-08-05"),
        savingsEvent("reserve", "reserve", 1_000, "2026-08-07"),
      ],
      SAVINGS_PLAN,
      "2026-07-10",
      "2026-08-09",
      "2026-08-10",
      "2026-08-09",
    );

    expect(progress).toMatchObject({
      targetMinor: 3_000,
      openingRetainedMinor: 5_000n,
      closingRetainedMinor: 6_000n,
      netGrowthMinor: 1_000n,
      remainingTargetMinor: 2_000n,
    });
  });

  it("treats a late correction of the previous settlement as current-cycle opening money", () => {
    const progress = calculateCycleSavingsProgress(
      [
        savingsEvent("opening", "opening", 5_000, "2026-07-01"),
        settlement(
          "2026-07-10",
          "2026-08-09",
          2_500,
          "settlement-2026-07-10",
          "2026-08-15",
        ),
        savingsEvent("current-reserve", "reserve", 500, "2026-08-12"),
      ],
      SAVINGS_PLAN,
      "2026-08-10",
      "2026-09-09",
      "2026-09-10",
      "2026-08-20",
    );

    expect(progress).toMatchObject({
      openingRetainedMinor: 7_500n,
      closingRetainedMinor: 8_000n,
      netGrowthMinor: 500n,
      remainingTargetMinor: 2_500n,
    });
  });

  it("requires replacing retained money released during the cycle", () => {
    const progress = calculateCycleSavingsProgress(
      [
        savingsEvent("opening", "opening", 5_000, "2026-07-01"),
        savingsEvent("release", "release", 2_000, "2026-07-20"),
        savingsEvent("reserve", "reserve", 500, "2026-08-01"),
      ],
      SAVINGS_PLAN,
      "2026-07-10",
      "2026-08-09",
      "2026-08-10",
      "2026-08-09",
    );

    expect(progress.netGrowthMinor).toBe(-1_500n);
    expect(progress.remainingTargetMinor).toBe(4_500n);
  });

  it("uses an override only for its matching, possibly delayed payday", () => {
    const events = [savingsEvent("opening", "opening", 5_000, "2026-07-01")];
    const matching = calculateCycleSavingsProgress(
      events,
      SAVINGS_PLAN,
      "2026-07-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-09",
      { targetPaydayDateKey: "2026-08-12", targetMinor: 8_000 },
    );
    const stale = calculateCycleSavingsProgress(
      events,
      SAVINGS_PLAN,
      "2026-07-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-09",
      { targetPaydayDateKey: "2026-08-10", targetMinor: 8_000 },
    );

    expect(matching.targetMinor).toBe(8_000);
    expect(stale.targetMinor).toBe(3_000);
  });
});

describe("savings-aware spending analysis", () => {
  it("subtracts only money that was actually retained from spendable money", () => {
    const analysis = calculateSpendingAnalysis(
      [expense("2026-07-26", -1_400)],
      10_000,
      { paydayDay: 10, defaultSavingsTargetMinor: 1_000 },
      forecast(),
      new Date(2026, 7, 9, 12),
      [],
      [
        savingsEvent("opening", "opening", 5_000, "2026-07-01"),
        savingsEvent("reserve", "reserve", 400, "2026-08-01"),
      ],
    );

    expect(analysis.currentCycle).toMatchObject({
      totalBalanceMinor: 10_000n,
      retainedBalanceMinor: 5_400n,
      spendableBalanceMinor: 4_600n,
      safeToSpendMinor: 4_600n,
      projectedEndBalanceMinor: 9_900n,
      savingsDifferenceMinor: 4_500n,
      savingsAffordability: "surplus",
    });
    expect(analysis.nextCycle.referenceSpendMinor).toBe(3_100);
    expect(analysis.nextCycle.minimumIncomeScenario).toMatchObject({
      incomeMinor: 4_100,
      differenceMinor: 1_000n,
      affordability: "surplus",
    });
    expect(analysis.nextCycle.expectedIncomeScenario).toMatchObject({
      differenceMinor: 1_900n,
      affordability: "surplus",
    });
  });

  it("marks a negative retained balance for correction without truncating it", () => {
    const analysis = calculateSpendingAnalysis(
      [expense("2026-07-26", -1_400)],
      1_000,
      SAVINGS_PLAN,
      forecast(),
      new Date(2026, 7, 9, 12),
      [],
      [
        savingsEvent("opening", "opening", 500, "2026-07-01"),
        savingsEvent("release", "release", 1_500, "2026-08-01"),
      ],
    );

    expect(analysis.retainedSavings?.totalRetainedMinor).toBe(-1_000n);
    expect(analysis.currentCycle.spendableBalanceMinor).toBe(2_000n);
    expect(analysis.currentCycle.safeToSpendMinor).toBe(2_000n);
    expect(analysis.currentCycle.savingsNeedsCorrection).toBe(true);
  });

  it("does not let legacy cycle targets change either affordability result", () => {
    const analysis = calculateSpendingAnalysis(
      [expense("2026-07-26", -1_400)],
      20_000,
      SAVINGS_PLAN,
      forecast({ targetPaydayDateKey: "2026-08-12" }),
      new Date(2026, 7, 9, 12),
      [],
      {
        savingsEvents: [],
        targetOverride: { targetPaydayDateKey: "2026-08-12", targetMinor: 8_000 },
      },
    );

    expect(analysis.currentCycle.spendableBalanceMinor).toBe(20_000n);
    expect(analysis.nextCycle.defaultSavingsTargetMinor).toBeUndefined();
    expect(analysis.nextCycle.minimumIncomeScenario?.savingsTargetMinor).toBeUndefined();
  });

  it("starts the new cycle at the delayed settlement boundary after the forecast is cleared", () => {
    const delayedSettlement = settlement(
      "2026-07-10",
      "2026-08-11",
      2_000,
      "settlement-2026-07-10",
      "2026-08-12",
    );
    const analysis = calculateSpendingAnalysis(
      [
        expense("2026-08-11", -900),
        expense("2026-08-12", -400),
      ],
      20_000,
      SAVINGS_PLAN,
      undefined,
      new Date(2026, 7, 12, 12),
      [],
      [delayedSettlement],
    );

    expect(analysis.currentCycle).toMatchObject({
      cycleStartDateKey: "2026-08-12",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      actualExpenseMinor: 400,
    });
    expect(analysis.savingsHistory?.at(-1)).toMatchObject({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-11",
      settled: true,
    });
  });
});

describe("savings history", () => {
  it("builds six completed cycles from the first observed retained-money date", () => {
    const events: SavingsEvent[] = [
      savingsEvent("opening", "opening", 1_000, "2026-02-10"),
      savingsEvent("feb", "reserve", 100, "2026-02-11"),
      savingsEvent("mar", "reserve", 200, "2026-03-11"),
      savingsEvent("apr", "reserve", 300, "2026-04-11"),
      savingsEvent("may", "reserve", 400, "2026-05-11"),
      savingsEvent("jun", "reserve", 500, "2026-06-11"),
      savingsEvent("jul", "reserve", 600, "2026-07-11"),
    ];

    const history = calculateSavingsHistory(
      events,
      { paydayDay: 10, defaultSavingsTargetMinor: 500 },
      "2026-08-10",
    );

    expect(history).toHaveLength(6);
    expect(history[0]).toMatchObject({
      cycleStartDateKey: "2026-02-10",
      targetMinor: 500,
      openingRetainedMinor: 1_000n,
      netGrowthMinor: 100n,
    });
    expect(history.at(-1)).toMatchObject({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      netGrowthMinor: 600n,
    });
  });

  it("uses a settlement snapshot instead of rewriting history with the latest target", () => {
    const settled = {
      ...settlement("2026-07-10", "2026-08-09", 500),
      goalMinorSnapshot: 2_000,
      openingRetainedMinor: 8_000,
      closingRetainedMinor: 9_500,
      netGrowthMinor: 1_500,
    } as SavingsEvent;
    const history = calculateSavingsHistory(
      [savingsEvent("opening", "opening", 8_000, "2026-07-01"), settled],
      { paydayDay: 10, defaultSavingsTargetMinor: 99_000 },
      "2026-08-10",
    );

    expect(history.at(-1)).toMatchObject({
      targetMinor: 2_000,
      openingRetainedMinor: 8_000n,
      closingRetainedMinor: 9_500n,
      netGrowthMinor: 1_500n,
      settled: true,
      needsCorrection: false,
    });
  });

  it("keeps the exact dates of a delayed settled cycle", () => {
    const delayed = settlement(
      "2026-07-10",
      "2026-08-11",
      500,
      "settlement-delayed",
      "2026-08-12",
    );
    const history = calculateSavingsHistory(
      [delayed],
      SAVINGS_PLAN,
      "2026-08-12",
    );

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-11",
      settled: true,
    });
  });
});
