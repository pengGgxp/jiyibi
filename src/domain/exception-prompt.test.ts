import { describe, expect, it } from "vitest";
import { evaluateExceptionPrompt } from "./exception-prompt";
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

describe("evaluateExceptionPrompt", () => {
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
});
