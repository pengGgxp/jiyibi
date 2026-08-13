import { describe, expect, it } from "vitest";
import { calculateLedgerSummary, calculateSpendingAnalysis } from "./stats";
import { testEntry, TEST_LEDGER_NOW, TEST_LEDGER_PLAN } from "./test-ledgers";
import type { IncomeForecast, RecoveryAllocation } from "./types";
import { resolveNextPaydayDateKey } from "./date";

function forecast(): IncomeForecast {
  return {
    id: "income-forecast",
    targetPaydayDateKey: resolveNextPaydayDateKey(TEST_LEDGER_PLAN.paydayDay, TEST_LEDGER_NOW),
    minimumIncomeMinor: 250_000,
    expectedIncomeMinor: 310_000,
  };
}

describe("treatment-aware balance and daily spend (P4)", () => {
  it("excludes confirmed account transfers from balance and cashflow", () => {
    const entries = [
      testEntry("2026-08-01", -5_000, {
        id: "transfer-out",
        treatment: "account_transfer",
        confirmationStatus: "confirmed",
      }),
      testEntry("2026-08-01", 5_000, {
        id: "transfer-in",
        treatment: "account_transfer",
        confirmationStatus: "confirmed",
      }),
      testEntry("2026-08-02", -1_000),
    ];
    const summary = calculateLedgerSummary(entries, { initialBalanceMinor: 10_000 }, "2026-08");
    expect(summary.balanceMinor).toBe(9_000);
    expect(summary.monthExpenseMinor).toBe(1_000);
    expect(summary.monthIncomeMinor).toBe(0);
  });

  it("keeps one-time expenses in balance but out of the daily-spend baseline", () => {
    const entries = [
      testEntry("2026-07-12", -100),
      testEntry("2026-07-20", -50_000, {
        id: "device",
        treatment: "one_time_expense",
        confirmationStatus: "confirmed",
      }),
      testEntry("2026-08-09", -200),
    ];
    const summary = calculateLedgerSummary(entries, { initialBalanceMinor: 100_000 }, "2026-07");
    expect(summary.balanceMinor).toBe(100_000 - 100 - 50_000 - 200);
    expect(summary.monthExpenseMinor).toBe(50_100);

    const analysis = calculateSpendingAnalysis(
      entries,
      summary.balanceMinor,
      TEST_LEDGER_PLAN,
      forecast(),
      TEST_LEDGER_NOW,
    );
    expect(analysis.window.totalExpenseMinor).toBe(300);
    expect(analysis.currentCycle.actualExpenseMinor).toBe(0);
  });

  it("reduces ordinary expense baseline by recovery allocations only", () => {
    const expense = testEntry("2026-07-12", -1_000, { id: "expense-1" });
    const refund = testEntry("2026-08-01", 400, {
      id: "refund-1",
      treatment: "refund_reimbursement",
      confirmationStatus: "confirmed",
    });
    const later = testEntry("2026-08-09", -200);
    const allocations: RecoveryAllocation[] = [{
      id: "alloc-1",
      refundEntryId: "refund-1",
      expenseEntryId: "expense-1",
      amountMinor: 400,
      createdAt: "2026-08-01T04:00:00.000Z",
      updatedAt: "2026-08-01T04:00:00.000Z",
    }];

    const analysis = calculateSpendingAnalysis(
      [expense, refund, later],
      100_000,
      TEST_LEDGER_PLAN,
      forecast(),
      TEST_LEDGER_NOW,
      allocations,
    );
    // Net ordinary baseline: (1000-400) + 200
    expect(analysis.window.totalExpenseMinor).toBe(800);
    expect(analysis.dailyExpenses.find((day) => day.dateKey === "2026-07-12")?.expenseMinor)
      .toBe(600);
    // Gross cycle actuals still see only later expense in August cycle start Aug 10?
    // today is Aug 10; cycle depends on payday 10.
  });

  it("does not let reimbursable expenses open or fill the daily baseline", () => {
    const analysis = calculateSpendingAnalysis(
      [
        testEntry("2026-07-12", -8_000, {
          id: "pad",
          treatment: "reimbursable_expense",
          confirmationStatus: "confirmed",
        }),
        testEntry("2026-08-09", -200),
      ],
      100_000,
      TEST_LEDGER_PLAN,
      forecast(),
      TEST_LEDGER_NOW,
    );
    expect(analysis.window.startDateKey).toBe("2026-08-09");
    expect(analysis.window.totalExpenseMinor).toBe(200);
    expect(analysis.confidence).toBe("insufficient");
  });
});
