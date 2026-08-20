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
    // The due forecast keeps this ending cycle attached to the previous payday,
    // so all gross outflows in that cycle remain visible in actual cashflow.
    expect(analysis.currentCycle.actualExpenseMinor).toBe(50_300);
    expect(analysis.oneTimeExpenseMinor).toBe(50_000);
  });

  it("counts periodic bills as personal expense and cash outflow but not daily spend", () => {
    const periodic = testEntry("2026-07-20", -50_000, {
      id: "rent",
      treatment: "periodic_expense",
      confirmationStatus: "confirmed",
    });
    const ordinary = testEntry("2026-07-12", -10_000, { id: "food" });
    const entries = [ordinary, periodic];
    const summary = calculateLedgerSummary(
      entries,
      { initialBalanceMinor: 100_000 },
      "2026-07",
    );
    expect(summary).toMatchObject({
      balanceMinor: 40_000,
      monthExpenseMinor: 60_000,
      monthCashOutMinor: 60_000,
    });

    const analysis = calculateSpendingAnalysis(
      entries,
      summary.balanceMinor,
      TEST_LEDGER_PLAN,
      forecast(),
      TEST_LEDGER_NOW,
    );
    expect(analysis.window.totalExpenseMinor).toBe(10_000);
    expect(analysis.periodicExpenseMinor).toBe(50_000);
    expect(analysis.excludedExpenseMinor).toBe(50_000);
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

  it("keeps partial reimbursement out of income and attributes the final remainder", () => {
    const advance = testEntry("2026-07-12", -100_000, {
      id: "advance",
      treatment: "reimbursable_expense",
      confirmationStatus: "confirmed",
    });
    const refund = testEntry("2026-08-01", 80_000, {
      id: "refund",
      treatment: "refund_reimbursement",
      confirmationStatus: "confirmed",
    });
    const allocations: RecoveryAllocation[] = [{
      id: "alloc",
      refundEntryId: refund.id,
      expenseEntryId: advance.id,
      amountMinor: 80_000,
      createdAt: refund.createdAt,
      updatedAt: refund.updatedAt,
    }];

    const pendingJuly = calculateLedgerSummary(
      [advance, refund],
      { initialBalanceMinor: 200_000 },
      "2026-07",
      [],
      allocations,
    );
    const august = calculateLedgerSummary(
      [advance, refund],
      { initialBalanceMinor: 200_000 },
      "2026-08",
      [],
      allocations,
    );
    expect(pendingJuly).toMatchObject({
      balanceMinor: 180_000,
      monthIncomeMinor: 0,
      monthExpenseMinor: 0,
      monthCashInMinor: 0,
      monthCashOutMinor: 100_000,
    });
    expect(august).toMatchObject({
      monthIncomeMinor: 0,
      monthExpenseMinor: 0,
      monthCashInMinor: 80_000,
      monthCashOutMinor: 0,
    });

    for (const treatment of [
      "ordinary_expense",
      "periodic_expense",
      "one_time_expense",
    ] as const) {
      const closed = { ...advance, treatment };
      const summary = calculateLedgerSummary(
        [closed, refund],
        { initialBalanceMinor: 200_000 },
        "2026-07",
        [],
        allocations,
      );
      expect(summary.monthExpenseMinor).toBe(20_000);
      const analysis = calculateSpendingAnalysis(
        [closed, refund],
        summary.balanceMinor,
        TEST_LEDGER_PLAN,
        forecast(),
        TEST_LEDGER_NOW,
        allocations,
      );
      expect(analysis.window.totalExpenseMinor)
        .toBe(treatment === "ordinary_expense" ? 20_000 : 0);
    }
  });
});
