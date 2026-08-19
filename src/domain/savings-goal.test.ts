import { describe, expect, it } from "vitest";
import { listPaydayDateKeys } from "./date";
import {
  calculateSavingsGoalProgress,
  calculateSpendableBalanceMinor,
} from "./stats";
import type { RetainedSavingsSummary, SavingsGoal } from "./types";

function retained(totalRetainedMinor: bigint, needsCorrection = false): RetainedSavingsSummary {
  return {
    openingRetainedMinor: 0n,
    reservedMinor: totalRetainedMinor > 0n ? totalRetainedMinor : 0n,
    releasedMinor: totalRetainedMinor < 0n ? -totalRetainedMinor : 0n,
    settledMinor: 0n,
    totalRetainedMinor,
    hasNegativeBalance: totalRetainedMinor < 0n,
    needsCorrection,
  };
}

const GOAL: SavingsGoal = {
  targetDateKey: "2026-12-31",
  targetMinor: 100_000,
};

describe("cumulative savings goal", () => {
  it("keeps the goal independent from spendable money", () => {
    expect(calculateSpendableBalanceMinor(80_000, retained(20_000n))).toBe(60_000n);
    expect(calculateSpendableBalanceMinor(80_000, retained(0n))).toBe(80_000n);

    const progress = calculateSavingsGoalProgress(
      GOAL,
      retained(20_000n),
      10,
      new Date(2026, 7, 19, 12),
    );
    expect(progress.remainingMinor).toBe(80_000n);
    // The unfinished 80,000 goal is not deducted a second time.
    expect(calculateSpendableBalanceMinor(80_000, progress.retainedMinor)).toBe(60_000n);
  });

  it("derives completion, overdue and correction states", () => {
    expect(calculateSavingsGoalProgress(
      GOAL,
      retained(100_000n),
      10,
      new Date(2026, 7, 19, 12),
    )).toMatchObject({ status: "completed", remainingMinor: 0n });

    expect(calculateSavingsGoalProgress(
      { ...GOAL, targetDateKey: "2026-08-18" },
      retained(20_000n),
      10,
      new Date(2026, 7, 19, 12),
    )).toMatchObject({ status: "overdue", remainingMinor: 80_000n });

    expect(calculateSavingsGoalProgress(
      GOAL,
      retained(-1n, true),
      10,
      new Date(2026, 7, 19, 12),
    ).needsCorrection).toBe(true);
  });

  it("uses inclusive paydays and rounds the suggestion upward", () => {
    const onPayday = calculateSavingsGoalProgress(
      { targetDateKey: "2026-10-10", targetMinor: 10_001 },
      retained(0n),
      10,
      new Date(2026, 7, 10, 12),
    );
    expect(onPayday.remainingPaydayCount).toBe(3);
    expect(onPayday.suggestedPerCycleMinor).toBe(3_334n);

    const noPayday = calculateSavingsGoalProgress(
      { targetDateKey: "2026-08-09", targetMinor: 10_001 },
      retained(0n),
      10,
      new Date(2026, 7, 1, 12),
    );
    expect(noPayday.remainingPaydayCount).toBeUndefined();
    expect(noPayday.suggestedPerCycleMinor).toBeUndefined();
  });

  it("uses the last day in short months for a 29-31 payday", () => {
    expect(listPaydayDateKeys(31, "2027-01-31", "2027-03-31")).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
    ]);
    expect(listPaydayDateKeys(29, "2028-02-29", "2028-02-29")).toEqual([
      "2028-02-29",
    ]);
  });

  it("hides suggestions without a payday or after completion", () => {
    expect(calculateSavingsGoalProgress(
      GOAL,
      retained(0n),
      undefined,
      new Date(2026, 7, 19, 12),
    ).suggestedPerCycleMinor).toBeUndefined();
    expect(calculateSavingsGoalProgress(
      GOAL,
      retained(120_000n),
      10,
      new Date(2026, 7, 19, 12),
    ).suggestedPerCycleMinor).toBeUndefined();
  });
});
