import { describe, expect, it } from "vitest";
import {
  AmountError,
  amountMinorToInput,
  formatCny,
  kindToSignedMinor,
  parseSignedAmountToMinor,
  parseUnsignedAmountToMinor,
} from "./amount";
import {
  entryToLocalDateTimeInput,
  parseLocalDateTime,
  resolveIncomeForecastDateWindow,
  resolveIncomeForecastPostponeWindow,
  resolvePayCycleRange,
} from "./date";
import { calculateLedgerSummary, calculatePayCycleStatus } from "./stats";
import type { LedgerEntry } from "./types";
import { EntryValidationError, validateEntryDraft } from "./validation";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: "entry-1",
    amountMinor: -100,
    note: "午餐",
    occurredAt: "2026-07-30T04:00:00.000Z",
    localDateKey: "2026-07-30",
    localMonthKey: "2026-07",
    timezoneOffsetMinutes: -480,
    treatment: "ordinary_expense",
    confirmationStatus: "not_needed",
    createdAt: "2026-07-30T04:00:00.000Z",
    updatedAt: "2026-07-30T04:00:00.000Z",
    ...overrides,
  };
}

describe("amount helpers", () => {
  it("parses decimal input without floating point arithmetic", () => {
    expect(parseUnsignedAmountToMinor("12.3")).toBe(1230);
    expect(parseSignedAmountToMinor("-0.01")).toBe(-1);
    expect(kindToSignedMinor("expense", 1230)).toBe(-1230);
    expect(kindToSignedMinor("income", 1230)).toBe(1230);
    expect(amountMinorToInput(-1230)).toBe("12.30");
  });

  it.each(["", "0", "1.234", "-1", "1e3", "NaN"])("rejects invalid ledger amount %s", (value) => {
    expect(() => parseUnsignedAmountToMinor(value)).toThrow(AmountError);
  });
});

describe("stable local dates", () => {
  it("stores local date and month independently from UTC", () => {
    const parsed = parseLocalDateTime("2026-07-30T23:45");
    expect(parsed.localDateKey).toBe("2026-07-30");
    expect(parsed.localMonthKey).toBe("2026-07");
    expect(entryToLocalDateTimeInput(parsed.occurredAt, parsed.timezoneOffsetMinutes)).toBe(
      "2026-07-30T23:45",
    );
  });

  it("rejects impossible local dates", () => {
    expect(() => parseLocalDateTime("2026-02-30T12:00")).toThrow("日期或时间不存在");
  });
});

describe("entry validation and statistics", () => {
  it("requires note or an existing/new screenshot", () => {
    const draft = {
      kind: "expense" as const,
      amount: "10",
      note: "  ",
      occurredAtLocal: "2026-07-30T12:00",
    };
    expect(() => validateEntryDraft(draft)).toThrow(EntryValidationError);
    expect(validateEntryDraft(draft, true).amountMinor).toBe(-1000);
  });

  it("calculates balance and requested local month while ignoring deleted entries", () => {
    const entries = [
      entry({ id: "income", amountMinor: 10_000 }),
      entry({ id: "expense", amountMinor: -2_500 }),
      entry({ id: "old", amountMinor: -900, localMonthKey: "2026-06" }),
      entry({ id: "deleted", amountMinor: 99_999, deletedAt: "2026-07-31T00:00:00.000Z" }),
    ];
    expect(calculateLedgerSummary(entries, { initialBalanceMinor: 5_000 }, "2026-07")).toEqual({
      balanceMinor: 11_600,
      monthIncomeMinor: 10_000,
      monthExpenseMinor: 2_500,
    });
  });
});

describe("pay cycle", () => {
  it("resolves the income forecast window from today through the next regular cycle", () => {
    expect(resolveIncomeForecastDateWindow(15, new Date(2026, 7, 15, 12, 0))).toEqual({
      minimumDateKey: "2026-08-15",
      regularDateKey: "2026-09-15",
      maximumDateKey: "2026-10-14",
    });
  });

  it("keeps a postponed income before the next regular payday", () => {
    expect(resolveIncomeForecastPostponeWindow(
      15,
      "2026-08-15",
      new Date(2026, 7, 16, 12, 0),
    )).toEqual({
      minimumDateKey: "2026-08-16",
      maximumDateKey: "2026-09-14",
    });
  });

  it("has no postponement date after the income reaches its cycle boundary", () => {
    expect(resolveIncomeForecastPostponeWindow(
      15,
      "2026-09-14",
      new Date(2026, 8, 14, 12, 0),
    )).toEqual({
      minimumDateKey: "2026-09-15",
      maximumDateKey: "2026-09-14",
    });
  });

  it.each([
    [29, "2026-03-28"],
    [30, "2026-03-29"],
    [31, "2026-03-30"],
  ])("clamps payday %i to the last day of a short month", (paydayDay, maximumDateKey) => {
    expect(resolveIncomeForecastDateWindow(paydayDay, new Date(2026, 0, 31, 12, 0))).toEqual({
      minimumDateKey: "2026-01-31",
      regularDateKey: "2026-02-28",
      maximumDateKey,
    });
  });

  it("uses payday boundaries instead of natural months", () => {
    expect(resolvePayCycleRange(10, new Date(2026, 7, 9, 12, 0))).toEqual({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      nextPaydayDateKey: "2026-08-10",
      daysUntilPayday: 1,
    });
    expect(resolvePayCycleRange(10, new Date(2026, 7, 10, 12, 0))).toEqual({
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 31,
    });
  });

  it("uses the last day in months without the configured payday", () => {
    expect(resolvePayCycleRange(31, new Date(2026, 1, 28, 12, 0))).toEqual({
      cycleStartDateKey: "2026-02-28",
      cycleEndDateKey: "2026-03-30",
      nextPaydayDateKey: "2026-03-31",
      daysUntilPayday: 31,
    });
    expect(resolvePayCycleRange(31, new Date(2028, 1, 29, 12, 0)).cycleStartDateKey)
      .toBe("2028-02-29");
  });

  it("compares the actual balance with the cycle floor and tracks cycle activity", () => {
    const entries = [
      entry({ id: "before", amountMinor: -99_999, localDateKey: "2026-07-09" }),
      entry({ id: "salary-cycle-expense", amountMinor: -2_500, localDateKey: "2026-07-10" }),
      entry({ id: "extra-income", amountMinor: 1_000, localDateKey: "2026-08-08" }),
      entry({ id: "after", amountMinor: -99_999, localDateKey: "2026-08-10" }),
      entry({ id: "deleted", amountMinor: -50_000, localDateKey: "2026-08-01", deletedAt: "2026-08-02T00:00:00.000Z" }),
    ];
    expect(calculatePayCycleStatus(entries, 9_000, {
      paydayDay: 10,
      cycleEndBalanceGoalMinor: 10_000,
    }, new Date(2026, 7, 9, 12, 0))).toMatchObject({
      targetMinor: 10_000,
      balanceHeadroomMinor: -1_000n,
      isCurrentlyAtOrAboveGoal: false,
      cycleExpenseMinor: 2_500,
      cycleIncomeMinor: 1_000,
      safeToSpendMinor: 0n,
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      nextPaydayDateKey: "2026-08-10",
      daysUntilPayday: 1,
    });
  });

  it("keeps exact differences for large valid balances", () => {
    const status = calculatePayCycleStatus([], 9_000_000_000_000_000, {
      paydayDay: 1,
      cycleEndBalanceGoalMinor: -9_000_000_000_000_000,
    });
    expect(status.balanceHeadroomMinor).toBe(18_000_000_000_000_000n);
    expect(status.safeToSpendMinor).toBe(18_000_000_000_000_000n);
    expect(formatCny(status.balanceHeadroomMinor)).toBe("¥180,000,000,000,000.00");
  });
});
