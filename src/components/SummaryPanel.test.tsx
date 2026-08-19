import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ForecastOutcome,
  LedgerSummary,
  PayCyclePlan,
  RetainedSavingsSummary,
  SpendingAnalysis,
} from "../domain";
import { SummaryPanel } from "./SummaryPanel";

const summary: LedgerSummary = { balanceMinor: 80_000, monthIncomeMinor: 100_000, monthExpenseMinor: 20_000 };
const plan: PayCyclePlan = { paydayDay: 10 };
const retained: RetainedSavingsSummary = {
  openingRetainedMinor: 20_000n,
  reservedMinor: 0n,
  releasedMinor: 0n,
  settledMinor: 0n,
  totalRetainedMinor: 20_000n,
  hasNegativeBalance: false,
  needsCorrection: false,
};

function settings(withForecast = true): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    payCycle: plan,
    savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 100_000 },
    ...(withForecast ? { incomeForecast: { id: "forecast-1", targetPaydayDateKey: "2026-09-10", expectedIncomeMinor: 100_000 } } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function analysis(outcome: ForecastOutcome = "surplus", confidence: SpendingAnalysis["confidence"] = "ready"): SpendingAnalysis {
  const difference = outcome === "shortfall" ? -2_500n : outcome === "exact" ? 0n : 12_500n;
  return {
    asOfDateKey: "2026-08-20",
    confidence,
    window: {
      startDateKey: "2026-07-21",
      endDateKey: "2026-08-19",
      observedDays: confidence === "insufficient" ? 5 : 30,
      daysNeeded: 14,
      totalExpenseMinor: 30_000,
      averageDailyExpenseMinor: 1_000,
    },
    includedExpenseMinor: 30_000,
    excludedExpenseMinor: 0,
    pendingConfirmationCount: 0,
    retainedSavings: retained,
    savingsGoal: {
      targetDateKey: "2026-12-31",
      targetMinor: 100_000,
      retainedMinor: 20_000n,
      remainingMinor: 80_000n,
      status: "active",
      remainingPaydayCount: 4,
      suggestedPerCycleMinor: 20_000n,
      needsCorrection: false,
    },
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 20_000,
      balanceHeadroomMinor: 60_000n,
      safeToSpendMinor: 60_000n,
      dailySafeToSpendMinor: 2_857n,
      totalBalanceMinor: 80_000n,
      retainedBalanceMinor: 20_000n,
      spendableBalanceMinor: 60_000n,
      ...(confidence === "insufficient" ? {} : {
        estimatedRemainingExpenseMinor: 25_000,
        projectedEndBalanceMinor: 55_000n,
        balanceGoalDifferenceMinor: difference,
        affordability: outcome,
      }),
    },
    nextCycle: {
      cycleStartDateKey: "2026-09-10",
      cycleEndDateKey: "2026-10-09",
      nextPaydayDateKey: "2026-10-10",
      days: 30,
      ...(confidence === "insufficient" ? {} : {
        referenceSpendMinor: 90_000,
        expectedIncomeScenario: { incomeMinor: 100_000, differenceMinor: 10_000n, affordability: "surplus" as const },
      }),
    },
    dailyExpenses: [],
    currentCycleSeries: [],
    completedCycles: [],
  };
}

function renderPanel(options: {
  appSettings?: AppSettings;
  payCycle?: PayCyclePlan;
  spending?: SpendingAnalysis;
  retainedSavings?: RetainedSavingsSummary;
  error?: Error;
} = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={summary}
      settings={options.appSettings ?? settings()}
      payCycle={options.payCycle}
      analysis={options.spending}
      retainedSavings={options.retainedSavings ?? retained}
      analysisError={options.error}
      loading={false}
      onOpenSettings={vi.fn()}
      onOpenIncomeForecast={vi.fn()}
      onOpenSavingsGoal={vi.fn()}
      onOpenAnalysis={vi.fn()}
      onReserveSavings={vi.fn()}
      onReleaseSavings={vi.fn()}
    />,
  );
  return host;
}

describe("SummaryPanel", () => {
  it("shows spendable, total and saved money without pre-deducting the unfinished goal", () => {
    const panel = renderPanel();
    expect(panel.querySelector(".balance-value")?.textContent).toBe("¥600.00");
    expect(panel.textContent).toContain("总余额¥800.00");
    expect(panel.textContent).toContain("已存¥200.00");
    expect(panel.textContent).not.toContain("尚需留存");
  });

  it("shows a semantic cumulative savings goal and hides per-cycle suggestion", () => {
    const panel = renderPanel({ payCycle: plan, spending: analysis() });
    const progress = panel.querySelector<HTMLProgressElement>("progress");
    expect(progress?.max).toBe(100_000);
    expect(progress?.value).toBe(20_000);
    expect(progress?.getAttribute("aria-valuetext")).toContain("已存 ¥200.00，目标 ¥1,000.00");
    expect(panel.textContent).toContain("12月31日");
    expect(panel.textContent).not.toContain("每期建议");
  });

  it("uses one compact verdict for current money and one for expected income", () => {
    const panel = renderPanel({ payCycle: plan, spending: analysis() });
    expect(panel.textContent).toContain("到下次够花+¥125.00");
    expect(panel.textContent).toContain("下次收入¥1,000.00够花 +¥100.00");
    expect(panel.textContent).not.toContain("最低收入");
    expect(panel.textContent).not.toContain("每日可花");
  });

  it("does not invent a verdict with less than fourteen days", () => {
    const panel = renderPanel({ payCycle: plan, spending: analysis("surplus", "insufficient") });
    expect(panel.textContent).toContain("待估算差 9 天");
    expect(panel.textContent).not.toContain("够花+");
  });

  it("offers one expected-income form when it is missing", () => {
    const appSettings = settings(false);
    const panel = renderPanel({ appSettings, payCycle: plan, spending: analysis() });
    expect(panel.textContent).toContain("下次收入未填写填写");
    expect(panel.textContent).not.toContain("最低收入");
  });

  it("offers pay-cycle setup without coupling it to a savings target", () => {
    const appSettings = settings(false);
    delete appSettings.payCycle;
    const panel = renderPanel({ appSettings });
    expect(panel.textContent).toContain("设置发薪日");
    expect(panel.textContent).not.toContain("周期目标");
  });
});
