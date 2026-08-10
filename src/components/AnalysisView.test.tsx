import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettings, PayCyclePlan, SpendingAnalysis } from "../domain";
import { AnalysisView } from "./AnalysisView";

vi.mock("recharts", () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div data-chart-container="true">{children}</div>;
  const LineSeries = ({ name, strokeDasharray }: { name?: string; strokeDasharray?: string }) => (
    <i data-chart-series={name} data-line-style={strokeDasharray ? "dashed" : "solid"} />
  );
  const Reference = ({ label, ifOverflow }: { label?: { value?: string }; ifOverflow?: string }) => (
    <i data-reference-line={label?.value ?? "reference"} data-if-overflow={ifOverflow} />
  );
  const BarSeries = ({ name }: { name?: string }) => <i data-chart-series={name} />;
  return {
    ResponsiveContainer: Container,
    LineChart: Container,
    BarChart: Container,
    CartesianGrid: () => null,
    Legend: () => null,
    Line: LineSeries,
    ReferenceLine: Reference,
    Bar: BarSeries,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

const plan: PayCyclePlan = {
  paydayDay: 10,
  monthlySalaryMinor: 800_000,
  cycleEndBalanceGoalMinor: 100_000,
};

const settings: AppSettings = {
  id: "primary",
  currency: "CNY",
  initialBalanceMinor: 0,
  payCycle: plan,
  schemaVersion: 1,
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function analysis(
  confidence: SpendingAnalysis["confidence"] = "ready",
  outcome: "surplus" | "shortfall" | "exact" = "surplus",
): SpendingAnalysis {
  const prediction = confidence === "insufficient" ? {} : {
    estimatedRemainingExpenseMinor: 120_000,
    projectedEndBalanceMinor: outcome === "shortfall" ? 50_000n : outcome === "exact" ? 100_000n : 250_000n,
    balanceGoalDifferenceMinor: outcome === "shortfall" ? -50_000n : outcome === "exact" ? 0n : 150_000n,
    affordability: outcome,
  };
  const nextPrediction = confidence === "insufficient" ? {} : {
    estimatedExpenseMinor: outcome === "shortfall" ? 850_000 : outcome === "exact" ? 800_000 : 650_000,
    salaryDifferenceMinor: outcome === "shortfall" ? -50_000n : outcome === "exact" ? 0n : 150_000n,
    affordability: outcome,
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
    salaryReferenceMinor: plan.monthlySalaryMinor,
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 200_000,
      balanceHeadroomMinor: 500_000n,
      salaryRemainingMinor: 600_000n,
      safeToSpendMinor: 500_000n,
      dailySafeToSpendMinor: 23_809n,
      ...prediction,
    },
    nextCycle: {
      cycleStartDateKey: "2026-09-10",
      cycleEndDateKey: "2026-10-09",
      nextPaydayDateKey: "2026-10-10",
      days: 30,
      ...nextPrediction,
    },
    dailyExpenses: [
      { dateKey: "2026-08-18", expenseMinor: 0 },
      { dateKey: "2026-08-19", expenseMinor: 10_000 },
    ],
    currentCycleSeries: [
      { dateKey: "2026-08-10", actualCumulativeMinor: 50_000, isPaydayBoundary: true },
      { dateKey: "2026-08-20", actualCumulativeMinor: 200_000, projectedCumulativeMinor: 200_000, isPaydayBoundary: false },
      { dateKey: "2026-09-10", projectedCumulativeMinor: 320_000, isPaydayBoundary: true },
    ],
    completedCycles: [
      { cycleStartDateKey: "2026-07-10", cycleEndDateKey: "2026-08-09", dayCount: 31, expenseMinor: 500_000 },
    ],
  };
}

const mountedRoots: Root[] = [];
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(reactTestEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function renderView({
  result,
  appSettings = settings,
  entryCount = result ? 1 : 0,
  error,
}: {
  result?: SpendingAnalysis;
  appSettings?: AppSettings;
  entryCount?: number;
  error?: string;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onOpenSettings = vi.fn();
  const onOpenLedger = vi.fn();
  await act(async () => {
    root.render(
      <AnalysisView
        analysis={result}
        summary={{ balanceMinor: 600_000, monthIncomeMinor: 800_000, monthExpenseMinor: 240_000 }}
        settings={appSettings}
        entryCount={entryCount}
        error={error}
        onOpenSettings={onOpenSettings}
        onOpenLedger={onOpenLedger}
      />,
    );
  });
  return { host, onOpenSettings, onOpenLedger };
}

describe("AnalysisView states", () => {
  it("asks for a complete pay cycle plan before forecasting", async () => {
    const { host, onOpenSettings } = await renderView({
      appSettings: { ...settings, payCycle: undefined },
    });

    expect(host.textContent).toContain("先设置工资周期");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("去设置工资周期"));
    await act(async () => button?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("guides an empty ledger back to quick entry", async () => {
    const empty = analysis("insufficient");
    empty.window.observedDays = 0;
    empty.window.totalExpenseMinor = 0;
    empty.window.averageDailyExpenseMinor = undefined;
    empty.dailyExpenses = [];
    empty.currentCycleSeries = [];
    const { host, onOpenLedger } = await renderView({ result: empty, entryCount: 0 });

    expect(host.textContent).toContain("还没有可参考的花费");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("去记一笔"));
    await act(async () => button?.click());
    expect(onOpenLedger).toHaveBeenCalledOnce();
  });

  it("keeps today's actual amounts visible before a completed day exists", async () => {
    const todayOnly = analysis("insufficient");
    todayOnly.window.observedDays = 0;
    todayOnly.window.totalExpenseMinor = 0;
    todayOnly.window.averageDailyExpenseMinor = undefined;
    todayOnly.dailyExpenses = [];
    todayOnly.currentCycle.actualExpenseMinor = 2_400;
    const { host } = await renderView({ result: todayOnly, entryCount: 1 });

    expect(host.textContent).not.toContain("还没有可参考的花费");
    expect(host.textContent).toContain("本周期已支出");
    expect(host.textContent).toContain("¥24.00");
    expect(host.textContent).toContain("积累中");
    expect(host.textContent).not.toContain("预计够用");
  });

  it("explains why an insufficient sample does not produce a verdict", async () => {
    const { host } = await renderView({ result: analysis("insufficient") });

    expect(host.textContent).toContain("还需积累 9 个完整日");
    expect(host.textContent).toContain("积累中");
    expect(host.textContent).toContain("暂不预测周期末余额");
    expect(host.textContent).not.toContain("预计够用");
  });

  it("shows a recoverable error state", async () => {
    const { host, onOpenLedger } = await renderView({ error: "账目合计超出安全范围" });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("账目合计超出安全范围");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("回到账目"));
    await act(async () => button?.click());
    expect(onOpenLedger).toHaveBeenCalledOnce();
  });
});

describe("AnalysisView forecasts and charts", () => {
  it.each([
    ["surplus", "预计够用", "+¥1,500.00"],
    ["shortfall", "预计有缺口", "−¥500.00"],
    ["exact", "预计刚好覆盖", "¥0.00"],
  ] as const)("renders the %s outcome with explicit wording", async (outcome, verdict, difference) => {
    const { host } = await renderView({ result: analysis("ready", outcome) });

    expect(host.textContent).toContain(verdict);
    expect(host.textContent).toContain(difference);
  });

  it("renders three chart explanations and semantic data tables", async () => {
    const { host } = await renderView({ result: analysis() });

    expect(host.querySelectorAll(".analysis-chart-section")).toHaveLength(3);
    expect(host.querySelectorAll("table caption")).toHaveLength(3);
    expect(host.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('th[scope="row"]').length).toBeGreaterThan(0);
    expect(host.textContent).toContain("没有支出的日期也计入统计");
  });

  it("uses solid actuals, dashed predictions and a named salary reference", async () => {
    const { host } = await renderView({ result: analysis() });

    expect(host.querySelector('[data-chart-series="实际累计支出（实线）"]')?.getAttribute("data-line-style")).toBe("solid");
    expect(host.querySelector('[data-chart-series="预测累计支出（虚线）"]')?.getAttribute("data-line-style")).toBe("dashed");
    expect(host.querySelectorAll('[data-reference-line="当前工资参考"]')).toHaveLength(2);
    expect(Array.from(host.querySelectorAll('[data-reference-line="当前工资参考"]')).every(
      (line) => line.getAttribute("data-if-overflow") === "extendDomain",
    )).toBe(true);
    expect(host.textContent).toContain("实际累计支出（实线）");
    expect(host.textContent).toContain("预测累计支出（虚线）");
  });
});
