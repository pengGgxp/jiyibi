import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettings, SavingsEvent, SpendingAnalysis } from "../domain";
import { AnalysisView } from "./AnalysisView";

vi.mock("recharts", () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div data-chart-container="true">{children}</div>;
  const LineSeries = ({ name, strokeDasharray }: { name?: string; strokeDasharray?: string }) => <i data-chart-series={name} data-line-style={strokeDasharray ? "dashed" : "solid"} />;
  const BarSeries = ({ name }: { name?: string }) => <i data-chart-series={name} />;
  return {
    ResponsiveContainer: Container,
    LineChart: Container,
    BarChart: Container,
    CartesianGrid: () => null,
    Line: LineSeries,
    Bar: BarSeries,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

const settings: AppSettings = {
  id: "primary",
  currency: "CNY",
  initialBalanceMinor: 0,
  payCycle: { paydayDay: 10 },
  savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 500_000 },
  incomeForecast: { id: "forecast-1", targetPaydayDateKey: "2026-09-10", expectedIncomeMinor: 800_000 },
  schemaVersion: 1,
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const savingsEvents: SavingsEvent[] = [{
  id: "savings-opening",
  kind: "opening",
  amountMinor: 100_000,
  note: "已有存款",
  occurredAt: "2026-07-01T04:00:00.000Z",
  localDateKey: "2026-07-01",
  localMonthKey: "2026-07",
  timezoneOffsetMinutes: -480,
  createdAt: "2026-07-01T04:00:00.000Z",
  updatedAt: "2026-07-01T04:00:00.000Z",
}];

function analysis(confidence: SpendingAnalysis["confidence"] = "ready"): SpendingAnalysis {
  const forecast = confidence === "insufficient" ? {} : {
    estimatedRemainingExpenseMinor: 120_000,
    projectedEndBalanceMinor: 480_000n,
    balanceGoalDifferenceMinor: 380_000n,
    affordability: "surplus" as const,
  };
  const next = confidence === "insufficient" ? {} : {
    referenceSpendMinor: 650_000,
    expectedIncomeScenario: { incomeMinor: 800_000, differenceMinor: 150_000n, affordability: "surplus" as const },
  };
  const observedDays = confidence === "ready" ? 30 : confidence === "preliminary" ? 20 : 5;
  return {
    asOfDateKey: "2026-08-20",
    confidence,
    window: {
      startDateKey: "2026-07-21",
      endDateKey: "2026-08-19",
      observedDays,
      daysNeeded: 14,
      totalExpenseMinor: 300_000,
      averageDailyExpenseMinor: 10_000,
    },
    includedExpenseMinor: 300_000,
    excludedExpenseMinor: 0,
    pendingConfirmationCount: 0,
    retainedSavings: {
      openingRetainedMinor: 100_000n,
      reservedMinor: 0n,
      releasedMinor: 0n,
      settledMinor: 0n,
      totalRetainedMinor: 100_000n,
      hasNegativeBalance: false,
      needsCorrection: false,
    },
    savingsGoal: {
      targetDateKey: "2026-12-31",
      targetMinor: 500_000,
      retainedMinor: 100_000n,
      remainingMinor: 400_000n,
      status: "active",
      remainingPaydayCount: 4,
      suggestedPerCycleMinor: 100_000n,
      needsCorrection: false,
    },
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 200_000,
      balanceHeadroomMinor: 500_000n,
      safeToSpendMinor: 500_000n,
      dailySafeToSpendMinor: 23_809n,
      totalBalanceMinor: 600_000n,
      retainedBalanceMinor: 100_000n,
      spendableBalanceMinor: 500_000n,
      ...forecast,
    },
    nextCycle: {
      cycleStartDateKey: "2026-09-10",
      cycleEndDateKey: "2026-10-09",
      nextPaydayDateKey: "2026-10-10",
      days: 30,
      ...next,
    },
    dailyExpenses: [
      { dateKey: "2026-08-18", expenseMinor: 0 },
      { dateKey: "2026-08-19", expenseMinor: 10_000 },
    ],
    currentCycleSeries: [
      { dateKey: "2026-08-10", actualCumulativeMinor: 50_000, isPaydayBoundary: true },
      { dateKey: "2026-09-10", projectedCumulativeMinor: 320_000, isPaydayBoundary: true },
    ],
    completedCycles: [{ cycleStartDateKey: "2026-07-10", cycleEndDateKey: "2026-08-09", dayCount: 31, expenseMinor: 500_000 }],
  };
}

const roots: Root[] = [];
const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { reactEnv.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => {
  if (previousAct === undefined) Reflect.deleteProperty(reactEnv, "IS_REACT_ACT_ENVIRONMENT");
  else reactEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

async function renderView(result?: SpendingAnalysis, appSettings: AppSettings = settings, entryCount = 1) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onOpenSettings = vi.fn();
  const onOpenIncomeForecast = vi.fn();
  const onOpenLedger = vi.fn();
  await act(async () => root.render(
    <AnalysisView
      analysis={result}
      savingsEvents={savingsEvents}
      summary={{ balanceMinor: 600_000, monthIncomeMinor: 800_000, monthExpenseMinor: 240_000 }}
      settings={appSettings}
      entryCount={entryCount}
      onOpenSettings={onOpenSettings}
      onOpenIncomeForecast={onOpenIncomeForecast}
      onOpenLedger={onOpenLedger}
    />,
  ));
  return { host, onOpenSettings, onOpenIncomeForecast, onOpenLedger };
}

describe("AnalysisView", () => {
  it("shows a semantic savings goal with a derived per-cycle suggestion", async () => {
    const { host } = await renderView(analysis());
    const progress = host.querySelector<HTMLProgressElement>("progress");
    expect(progress?.value).toBe(100_000);
    expect(progress?.max).toBe(500_000);
    expect(progress?.getAttribute("aria-valuetext")).toContain("已存 ¥1,000.00");
    expect(host.textContent).toContain("每期建议¥1,000.00");
    expect(host.textContent).toContain("剩余 4 次到账");
  });

  it("uses one next-income scenario and removes cycle savings conclusions", async () => {
    const { host } = await renderView(analysis());
    expect(host.textContent).toContain("下次收入");
    expect(host.textContent).toContain("¥8,000.00");
    expect(host.textContent).not.toContain("最低收入");
    expect(host.textContent).not.toContain("本周期留存");
    expect(host.textContent).not.toContain("尚需留存");
  });

  it("renders exactly three useful charts with non-color legends and tables", async () => {
    const { host } = await renderView(analysis());
    expect(host.querySelectorAll(".analysis-chart-section")).toHaveLength(3);
    expect(host.querySelectorAll('[data-chart-series="实际支出"]')).toHaveLength(2);
    expect(host.querySelector('[data-chart-series="预测支出"]')?.getAttribute("data-line-style")).toBe("dashed");
    expect(host.querySelector('[data-chart-series="每日支出"]')).not.toBeNull();
    expect(Array.from(host.querySelectorAll("caption")).map((item) => item.textContent)).toEqual([
      "存钱明细",
      "当前周期累计支出",
      "完整到账周期支出",
      "每日支出",
    ]);
    expect(host.textContent).not.toContain("完整周期留存");
  });

  it("withholds financial verdicts when data is insufficient", async () => {
    const { host } = await renderView(analysis("insufficient"));
    expect(host.textContent).toContain("还差 9 天");
    expect(host.textContent).toContain("还差 9 个完整日");
    expect(host.textContent).not.toContain("截至昨天的 5 个完整日");
  });

  it("keeps savings goal visible without a pay cycle but hides the suggestion", async () => {
    const appSettings = { ...settings, payCycle: undefined };
    const { host, onOpenSettings } = await renderView(undefined, appSettings);
    expect(host.textContent).toContain("存钱目标");
    expect(host.textContent).not.toContain("每期建议");
    expect(host.textContent).toContain("设置发薪日");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("设置发薪日"));
    await act(async () => button?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("offers one forecast action when expected income is missing", async () => {
    const appSettings = { ...settings, incomeForecast: undefined };
    const result = analysis();
    result.nextCycle.expectedIncomeScenario = undefined;
    const { host, onOpenIncomeForecast } = await renderView(result, appSettings);
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("填写预计"));
    await act(async () => button?.click());
    expect(onOpenIncomeForecast).toHaveBeenCalledOnce();
  });
});
