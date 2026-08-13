import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ForecastOutcome,
  IncomeForecast,
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
  cycleEndBalanceGoalMinor: 10_000,
};

const incomeForecast: IncomeForecast = {
  id: "forecast-1",
  targetPaydayDateKey: "2026-09-10",
  minimumIncomeMinor: 80_000,
  expectedIncomeMinor: 100_000,
};

function settings(payCycle?: PayCyclePlan, forecast?: IncomeForecast): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(payCycle ? { payCycle } : {}),
    ...(forecast ? { incomeForecast: forecast } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function spendingAnalysis(
  confidence: SpendingAnalysis["confidence"],
  outcome?: ForecastOutcome,
): SpendingAnalysis {
  const difference = outcome === "shortfall" ? -2_500n : outcome === "exact" ? 0n : 12_500n;
  const projectedEndBalanceMinor = outcome === "shortfall"
    ? 7_500n
    : outcome === "exact"
      ? 10_000n
      : 22_500n;
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
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 20_000,
      balanceHeadroomMinor: 70_000n,
      safeToSpendMinor: 70_000n,
      dailySafeToSpendMinor: 3_333n,
      ...(outcome ? {
        estimatedRemainingExpenseMinor: 25_000,
        projectedEndBalanceMinor,
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
        referenceSpendMinor: 90_000,
        minimumIncomeScenario: {
          incomeMinor: 80_000,
          differenceMinor: -10_000n,
          affordability: "shortfall" as const,
        },
        expectedIncomeScenario: {
          incomeMinor: 100_000,
          differenceMinor: 10_000n,
          affordability: "surplus" as const,
        },
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
  forecast,
  error,
}: {
  analysis?: SpendingAnalysis;
  payCycle?: PayCyclePlan;
  forecast?: IncomeForecast;
  error?: Error;
} = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={summary}
      settings={settings(payCycle, forecast)}
      payCycle={payCycle}
      analysis={analysis}
      analysisError={error}
      loading={false}
      onOpenSettings={vi.fn()}
      onOpenIncomeForecast={vi.fn()}
      onOpenAnalysis={vi.fn()}
    />,
  );
  return host;
}

describe("SummaryPanel spending outlook", () => {
  it("keeps the balance prominent and offers pay-cycle setup", () => {
    const panel = renderPanel();

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥800.00");
    expect(panel.textContent).toContain("先设置发薪周期");
    expect(panel.textContent).toContain("收入每个周期单独填写");
    expect(panel.textContent).not.toContain("本月收入");
  });

  it("does not invent a verdict before fourteen completed days", () => {
    const panel = renderPanel({
      payCycle: plan,
      analysis: spendingAnalysis("insufficient"),
    });

    expect(panel.textContent).toContain("还需数据覆盖 9 个完整日");
    expect(panel.textContent).toContain("暂不判断");
    expect(panel.textContent).toContain("填写下次收入");
    expect(panel.textContent).not.toContain("预计够用");
  });

  it.each([
    ["surplus", "预计够用", "按近期已记录花法估算，高出底线 ¥125.00"],
    ["shortfall", "预计有缺口", "按近期已记录花法估算，短缺 ¥25.00"],
    ["exact", "预计刚好达到", "按近期已记录花法估算，周期末余额达到底线"],
  ] as const)("shows the current-cycle %s outcome in words and figures", (outcome, current, detail) => {
    const panel = renderPanel({
      payCycle: plan,
      forecast: incomeForecast,
      analysis: spendingAnalysis("ready", outcome),
    });

    expect(panel.textContent).toContain(current);
    expect(panel.textContent).toContain(detail);
    expect(panel.textContent).toContain("按近 30 天已记录花法估算");
    expect(panel.textContent).toContain("剩余天数21 天");
    expect(panel.textContent).toContain("每日可花¥33.33");
    expect(panel.querySelector<HTMLAnchorElement>(".summary-analysis-link")?.hash).toBe("#analysis");
  });

  it("shows minimum and expected income as separate next-cycle scenarios", () => {
    const panel = renderPanel({
      payCycle: plan,
      forecast: incomeForecast,
      analysis: spendingAnalysis("ready", "surplus"),
    });

    expect(panel.textContent).toContain("最低收入 ¥800.00");
    expect(panel.textContent).toContain("按近期已记录花法还差 ¥100.00");
    expect(panel.textContent).toContain("预计收入 ¥1,000.00");
    expect(panel.textContent).toContain("按近期已记录花法可多 ¥100.00");
    expect(panel.textContent).not.toContain("月工资");
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
