import { describe, expect, it } from "vitest";
import type { LedgerEntry, RecoveryAllocation } from "./types";
import { derivePendingItems, filterSnoozedPendingItems } from "./pending";

function entry(id: string, amountMinor: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    amountMinor,
    note: id,
    occurredAt: "2026-08-18T04:00:00.000Z",
    localDateKey: "2026-08-18",
    localMonthKey: "2026-08",
    timezoneOffsetMinutes: -480,
    treatment: amountMinor < 0 ? "ordinary_expense" : "ordinary_income",
    confirmationStatus: "not_needed",
    createdAt: "2026-08-18T04:00:00.000Z",
    updatedAt: "2026-08-18T04:00:00.000Z",
    ...overrides,
  };
}

describe("pending item derivation", () => {
  it("orders due income, treatment, savings penetration, and recovery links", () => {
    const expense = entry("expense", -10_000, { treatment: "reimbursable_expense" });
    const refund = entry("refund", 8_000, { treatment: "refund_reimbursement" });
    const pending = entry("pending", -2_000, { confirmationStatus: "pending" });

    const result = derivePendingItems({
      entries: [expense, refund, pending],
      allocations: [],
      incomeForecast: {
        id: "forecast",
        targetPaydayDateKey: "2026-08-19",
        expectedIncomeMinor: 100_000,
      },
      retainedMinor: 5_000n,
      balanceMinor: 2_000,
      todayDateKey: "2026-08-19",
    });

    expect(result.map((item) => item.kind)).toEqual([
      "income_due",
      "entry_treatment",
      "savings_penetration",
      "recovery_link",
    ]);
  });

  it("does not offer a fully allocated refund", () => {
    const expense = entry("expense", -5_000, { treatment: "reimbursable_expense" });
    const refund = entry("refund", 5_000, { treatment: "refund_reimbursement" });
    const allocations: RecoveryAllocation[] = [{
      id: "allocation",
      refundEntryId: refund.id,
      expenseEntryId: expense.id,
      amountMinor: 5_000,
      createdAt: refund.createdAt,
      updatedAt: refund.updatedAt,
    }];
    expect(derivePendingItems({
      entries: [expense, refund],
      allocations,
      retainedMinor: 0n,
      balanceMinor: 0,
      todayDateKey: "2026-08-19",
    })).toEqual([]);
  });

  it("does not ask to reconfirm a legacy actual-income receipt", () => {
    expect(derivePendingItems({
      entries: [entry("forecast", 100_000, { note: "本次实际收入" })],
      allocations: [],
      retainedMinor: 0n,
      balanceMinor: 100_000,
      todayDateKey: "2026-08-19",
    })).toEqual([]);
  });

  it("queues only persisted pending treatments instead of re-detecting history", () => {
    const legacy = entry("legacy", -30_000);
    const current = entry("current", -30_000, {
      detectionRuleVersion: 2,
    });
    const pending = entry("pending", -30_000, {
      confirmationStatus: "pending",
      detectionRuleVersion: 2,
    });
    const items = derivePendingItems({
      entries: [legacy, current, pending],
      allocations: [],
      retainedMinor: 0n,
      balanceMinor: 100_000,
      todayDateKey: "2026-08-19",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "treatment:pending" });
  });

  it("snoozes only the matching item for the current local day", () => {
    const item = derivePendingItems({
      entries: [entry("pending", -2_000, { confirmationStatus: "pending" })],
      allocations: [],
      retainedMinor: 0n,
      balanceMinor: 0,
      todayDateKey: "2026-08-19",
    });
    expect(filterSnoozedPendingItems(item, { [item[0]!.id]: "2026-08-19" }, "2026-08-19"))
      .toEqual([]);
    expect(filterSnoozedPendingItems(item, { [item[0]!.id]: "2026-08-18" }, "2026-08-19"))
      .toHaveLength(1);
  });
});
