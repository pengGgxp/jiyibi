import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ForecastOutcome,
  LedgerSummary,
  PayCyclePlan,
  SpendingAnalysis,
} from "../domain";
import { SummaryPanel } from "./SummaryPanel";

const summary: LedgerSummary = {
  balanceMinor: 80_000,
  monthIncomeMinor: 100_000,
  monthExpenseMinor: 20_000,
};

const plan: PayCyclePlan = {
  paydayDay: 10,
  monthlySalaryMinor: 100_000,
  cycleEndBalanceGoalMinor: 10_000,
};

function settings(payCycle?: PayCyclePlan): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(payCycle ? { payCycle } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function spendingAnalysis(
  confidence: SpendingAnalysis["confidence"],
  outcome?: ForecastOutcome,
): SpendingAnalysis {
  const difference = outcome === "shortfall" ? -2_500n : outcome === "exact" ? 0n : 12_500n;
  return {
    asOfDateKey: "2026-08-20",
    confidence,
    window: {
      startDateKey: "2026-08-01",
      endDateKey: "2026-08-19",
      observedDays: confidence === "insufficient" ? 5 : confidence === "preliminary" ? 20 : 30,
      daysNeeded: 14,
      totalExpenseMinor: 30_000,
      averageDailyExpenseMinor: 1_000,
    },
    salaryReferenceMinor: plan.monthlySalaryMinor,
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 20_000,
      balanceHeadroomMinor: 70_000n,
      salaryRemainingMinor: 80_000n,
      safeToSpendMinor: 70_000n,
      dailySafeToSpendMinor: 3_333n,
      ...(outcome ? {
        estimatedRemainingExpenseMinor: 25_000,
        projectedEndBalanceMinor: 55_000n,
        balanceGoalDifferenceMinor: difference,
        affordability: outcome,
      } : {}),
    },
    nextCycle: {
      cycleStartDateKey: "2026-09-10",
      cycleEndDateKey: "2026-10-09",
      nextPaydayDateKey: "2026-10-10",
      days: 30,
      ...(outcome ? {
        estimatedExpenseMinor: 90_000,
        salaryDifferenceMinor: difference,
        affordability: outcome,
      } : {}),
    },
    dailyExpenses: [],
    currentCycleSeries: [],
    completedCycles: [],
  };
}

function renderPanel({
  analysis,
  payCycle,
  error,
}: {
  analysis?: SpendingAnalysis;
  payCycle?: PayCyclePlan;
  error?: Error;
} = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={summary}
      settings={settings(payCycle)}
      payCycle={payCycle}
      analysis={analysis}
      analysisError={error}
      loading={false}
      onOpenSettings={vi.fn()}
      onOpenAnalysis={vi.fn()}
    />,
  );
  return host;
}

describe("SummaryPanel spending outlook", () => {
  it("keeps the balance prominent and offers pay-cycle setup", () => {
    const panel = renderPanel();

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥800.00");
    expect(panel.textContent).toContain("先设置发薪日和工资");
    expect(panel.textContent).not.toContain("本月收入");
  });

  it("does not invent a verdict before fourteen completed days", () => {
    const panel = renderPanel({
      payCycle: plan,
      analysis: spendingAnalysis("insufficient"),
    });

    expect(panel.textContent).toContain("还需积累 9 个完整日");
    expect(panel.textContent).toContain("暂不判断");
    expect(panel.textContent).not.toContain("预计够用");
  });

  it.each([
    ["surplus", "预计够用", "工资预计够用", "¥125.00"],
    ["shortfall", "预计有缺口", "工资预计不够", "¥25.00"],
    ["exact", "预计刚好达到", "工资刚好覆盖", "周期末余额达到底线"],
  ] as const)("shows the %s outcome in words and figures", (outcome, current, next, detail) => {
    const panel = renderPanel({
      payCycle: plan,
      analysis: spendingAnalysis("ready", outcome),
    });

    expect(panel.textContent).toContain(current);
    expect(panel.textContent).toContain(next);
    expect(panel.textContent).toContain(detail);
    expect(panel.textContent).toContain("剩余天数21 天");
    expect(panel.textContent).toContain("每日可花¥33.33");
    expect(panel.querySelector<HTMLAnchorElement>(".summary-analysis-link")?.hash).toBe("#analysis");
  });

  it("shows an explicit calculation error without hiding the balance", () => {
    const panel = renderPanel({
      payCycle: plan,
      error: new RangeError("预测支出超出安全范围"),
    });

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥800.00");
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain("预测支出超出安全范围");
  });
});
