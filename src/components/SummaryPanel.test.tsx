import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ForecastOutcome,
  IncomeForecast,
  LedgerSummary,
  PayCyclePlan,
  RetainedSavingsSummary,
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
    includedExpenseMinor: 30_000,
    excludedExpenseMinor: 0,
    pendingConfirmationCount: 0,
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
  canSettleSavings = false,
  retainedSavings,
}: {
  analysis?: SpendingAnalysis;
  payCycle?: PayCyclePlan;
  forecast?: IncomeForecast;
  error?: Error;
  canSettleSavings?: boolean;
  retainedSavings?: RetainedSavingsSummary;
} = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={summary}
      settings={settings(payCycle, forecast)}
      payCycle={payCycle}
      analysis={analysis}
      retainedSavings={retainedSavings}
      analysisError={error}
      loading={false}
      onOpenSettings={vi.fn()}
      onOpenIncomeForecast={vi.fn()}
      onOpenAnalysis={vi.fn()}
      onReserveSavings={vi.fn()}
      onReleaseSavings={vi.fn()}
      canSettleSavings={canSettleSavings}
      onSettleSavings={vi.fn()}
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
    ["surplus", "预计够用", "完成留存目标后还可剩 ¥125.00"],
    ["shortfall", "预计有缺口", "完成留存目标还差 ¥25.00"],
    ["exact", "预计刚好达到", "按近期已记录花法估算，刚好完成留存目标"],
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
    expect(panel.textContent).not.toContain("周期底线");
    expect(panel.querySelector<HTMLAnchorElement>(".summary-analysis-link")?.hash).toBe("#analysis");
  });

  it("subtracts retained money even before a pay-cycle plan is configured", () => {
    const panel = renderPanel({
      retainedSavings: {
        openingRetainedMinor: 30_000n,
        reservedMinor: 0n,
        releasedMinor: 0n,
        settledMinor: 0n,
        totalRetainedMinor: 30_000n,
        hasNegativeBalance: false,
        needsCorrection: false,
      },
    });

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥500.00");
    expect(panel.textContent).toContain("总余额¥800.00");
    expect(panel.textContent).toContain("已留存¥300.00");
    expect(panel.textContent).toContain("留存一笔");
    expect(panel.textContent).toContain("取用留存");
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

  it("separates spendable, total, retained and current-cycle savings figures", () => {
    const analysis = spendingAnalysis("ready", "surplus");
    Object.assign(analysis.currentCycle, {
      totalBalanceMinor: 80_000n,
      retainedBalanceMinor: 20_000n,
      savingsTargetMinor: 10_000,
      cycleNetGrowthMinor: 4_000n,
      remainingSavingsTargetMinor: 6_000n,
      spendableBalanceMinor: 54_000n,
    });

    const panel = renderPanel({ payCycle: plan, analysis });

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥540.00");
    expect(panel.textContent).toContain("总余额¥800.00");
    expect(panel.textContent).toContain("已留存¥200.00");
    expect(panel.textContent).toContain("本周期目标¥100.00");
    expect(panel.textContent).toContain("净增长¥40.00");
    expect(panel.textContent).toContain("尚需留存¥60.00");
  });

  it("shows zero spendable balance and a written warning when retained money was used", () => {
    const analysis = spendingAnalysis("ready", "shortfall");
    Object.assign(analysis.currentCycle, {
      totalBalanceMinor: 8_000n,
      retainedBalanceMinor: 100_000n,
      savingsTargetMinor: 5_000,
      cycleNetGrowthMinor: 0n,
      remainingSavingsTargetMinor: 5_000n,
      spendableBalanceMinor: -7_000n,
    });

    const panel = renderPanel({ payCycle: plan, analysis });

    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥0.00");
    expect(panel.textContent).toContain("实际动用了留存");
  });

  it("shows today instead of a zero-day countdown on the expected income date", () => {
    const dueAnalysis = spendingAnalysis("ready", "surplus");
    dueAnalysis.currentCycle.daysUntilPayday = 0;
    const panel = renderPanel({
      payCycle: plan,
      forecast: incomeForecast,
      analysis: dueAnalysis,
    });

    expect(panel.textContent).toContain("剩余天数今天");
    expect(panel.textContent).not.toContain("剩余天数0 天");
  });

  it("offers manual settlement only when the completed cycle is unsettled and has no forecast", () => {
    const panel = renderPanel({
      payCycle: plan,
      analysis: spendingAnalysis("ready", "surplus"),
      canSettleSavings: true,
    });
    expect(panel.textContent).toContain("结算上个周期");

    const withForecast = renderPanel({
      payCycle: plan,
      forecast: incomeForecast,
      analysis: spendingAnalysis("ready", "surplus"),
      canSettleSavings: true,
    });
    expect(withForecast.textContent).not.toContain("结算上个周期");
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
