import { describe, expect, it } from "vitest";
import {
  AmountError,
  amountMinorToInput,
  kindToSignedMinor,
  parseSignedAmountToMinor,
  parseUnsignedAmountToMinor,
} from "./amount";
import { entryToLocalDateTimeInput, parseLocalDateTime } from "./date";
import { calculateLedgerSummary } from "./stats";
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
