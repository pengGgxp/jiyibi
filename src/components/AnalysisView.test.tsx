import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettings, IncomeForecast, PayCyclePlan, SpendingAnalysis } from "../domain";
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
  cycleEndBalanceGoalMinor: 100_000,
};

const incomeForecast: IncomeForecast = {
  id: "forecast-1",
  targetPaydayDateKey: "2026-09-10",
  minimumIncomeMinor: 600_000,
  expectedIncomeMinor: 800_000,
};

const settings: AppSettings = {
  id: "primary",
  currency: "CNY",
  initialBalanceMinor: 0,
  payCycle: plan,
  incomeForecast,
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
    referenceSpendMinor: 700_000,
    minimumIncomeScenario: {
      incomeMinor: incomeForecast.minimumIncomeMinor,
      differenceMinor: -100_000n,
      affordability: "shortfall" as const,
    },
    expectedIncomeScenario: {
      incomeMinor: incomeForecast.expectedIncomeMinor,
      differenceMinor: 100_000n,
      affordability: "surplus" as const,
    },
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
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
    currentCycle: {
      cycleStartDateKey: "2026-08-10",
      cycleEndDateKey: "2026-09-09",
      nextPaydayDateKey: "2026-09-10",
      daysUntilPayday: 21,
      actualExpenseMinor: 200_000,
      balanceHeadroomMinor: 500_000n,
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
  const onOpenIncomeForecast = vi.fn();
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
        onOpenIncomeForecast={onOpenIncomeForecast}
        onOpenLedger={onOpenLedger}
      />,
    );
  });
  return { host, onOpenSettings, onOpenIncomeForecast, onOpenLedger };
}

describe("AnalysisView states", () => {
  it("asks for a complete pay cycle plan before forecasting", async () => {
    const { host, onOpenSettings } = await renderView({
      appSettings: { ...settings, payCycle: undefined },
    });

    expect(host.textContent).toContain("先设置发薪周期");
    expect(host.textContent).toContain("需要发薪日和周期底线。");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("设置发薪周期"));
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

    expect(host.textContent).toContain("还没有支出记录");
    expect(host.textContent).toContain("支出数据覆盖满 14 个完整日后开始估算。");
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

    expect(host.textContent).not.toContain("还没有支出记录");
    expect(host.textContent).toContain("本周期实际支出");
    expect(host.textContent).toContain("实际现金流");
    expect(host.textContent).toContain("日常花法");
    expect(host.textContent).toContain("¥24.00");
    expect(host.textContent).toContain("数据覆盖还差 14 天");
    expect(host.textContent).toContain("满 14 天数据覆盖后开始估算");
    expect(host.textContent).toContain("暂不预测周期末余额");
    expect(host.textContent).not.toContain("日常花法数据覆盖截至昨天");
    expect(host.textContent).not.toContain("保守估算");
    expect(host.textContent).not.toContain("预计够用");
  });

  it("explains why an insufficient sample does not produce a verdict", async () => {
    const { host } = await renderView({ result: analysis("insufficient") });

    expect(host.textContent).toContain("数据覆盖还差 9 天");
    expect(host.textContent).toContain("满 14 天数据覆盖后开始估算");
    expect(host.textContent).toContain("暂不预测周期末余额");
    expect(host.textContent).toContain("数据覆盖不足，暂不判断");
    expect(host.textContent).toContain("实际现金流");
    expect(host.textContent).toContain("日常花法");
    expect(host.textContent).not.toContain("日常花法数据覆盖截至昨天");
    expect(host.textContent).not.toContain("保守估算");
    expect(host.textContent).not.toContain("预计够用");
  });

  it("shows a recoverable error state", async () => {
    const { host, onOpenLedger } = await renderView({ error: "账目合计超出安全范围" });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("账目合计超出安全范围");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请检查账目后重新打开分析页");
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("返回记账页"));
    await act(async () => button?.click());
    expect(onOpenLedger).toHaveBeenCalledOnce();
  });

  it("gives storage read failures a relevant retry instruction", async () => {
    const { host } = await renderView({ error: "无法读取本机账目" });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("无法读取本机账目。请刷新页面重试。");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("请检查账目");
  });
});

describe("AnalysisView forecasts and charts", () => {
  it("uses the concise confidence labels for preliminary data", async () => {
    const { host } = await renderView({ result: analysis("preliminary") });

    expect(host.textContent).toContain("初步估算");
    expect(host.textContent).toContain("数据覆盖 20 天 · 不代表记录完整");
  });

  it.each([
    ["surplus", "预计够用", "+¥1,500.00"],
    ["shortfall", "预计有缺口", "−¥500.00"],
    ["exact", "预计刚好覆盖", "¥0.00"],
  ] as const)("renders the %s outcome with explicit wording", async (outcome, verdict, difference) => {
    const { host } = await renderView({ result: analysis("ready", outcome) });

    expect(host.textContent).toContain(verdict);
    expect(host.textContent).toContain(difference);
  });

  it("renders minimum and expected income as separate scenarios", async () => {
    const { host } = await renderView({ result: analysis("ready") });

    expect(host.textContent).toContain("最低收入 ¥6,000.00");
    expect(host.textContent).toContain("按近期已记录花法还差 ¥1,000.00");
    expect(host.textContent).toContain("预计收入 ¥8,000.00");
    expect(host.textContent).toContain("按近期已记录花法可多 ¥1,000.00");
    expect(host.textContent).toContain("最低收入差额−¥1,000.00");
    expect(host.textContent).toContain("预计收入差额+¥1,000.00");
    expect(host.textContent).toContain("实际现金流");
    expect(host.textContent).toContain("日常花法");
    expect(host.textContent).not.toContain("月工资");
  });

  it("keeps the analysis visible when the next income forecast is missing", async () => {
    const { host, onOpenIncomeForecast } = await renderView({
      result: analysis("ready"),
      appSettings: { ...settings, incomeForecast: undefined },
    });

    expect(host.textContent).toContain("预计周期末余额");
    expect(host.textContent).toContain("当前周期累计支出");
    const button = Array.from(host.querySelectorAll("button"))
      .find((item) => item.textContent?.includes("填写下次收入"));
    await act(async () => button?.click());
    expect(onOpenIncomeForecast).toHaveBeenCalledOnce();
  });

  it("renders three chart explanations and semantic data tables", async () => {
    const { host } = await renderView({ result: analysis() });

    expect(host.querySelectorAll(".analysis-chart-section")).toHaveLength(3);
    expect(host.querySelectorAll("table caption")).toHaveLength(3);
    expect(host.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('th[scope="row"]').length).toBeGreaterThan(0);
    expect(host.textContent).toContain("当前周期累计支出");
    expect(host.textContent).toContain("完整工资周期支出");
    expect(host.textContent).toContain("近 30 个完整日的每日支出");
    expect(host.textContent).toContain("实际现金流");
    expect(host.textContent).toContain("日常花法");
    expect(host.textContent).toContain("包含 0 支出日");
    expect(host.textContent).toContain("日常花法数据覆盖截至昨天的");
    expect(host.textContent).toContain("不代表记录完整");
    expect((host.textContent?.match(/日常花法数据覆盖截至昨天的/g) ?? []).length).toBe(1);
    for (const oldCopy of [
      "资金判断",
      "两段钱，分别回答",
      "把依据摆在一起",
      "花费速度",
      "工资基线",
      "可绘制的支出点",
      "一定够用",
      "保证够用",
    ]) {
      expect(host.textContent).not.toContain(oldCopy);
    }
  });

  it("uses the requested empty chart labels without implementation language", async () => {
    const result = analysis("preliminary");
    result.currentCycleSeries = [];
    result.completedCycles = [];
    result.dailyExpenses = [];
    const { host } = await renderView({ result, entryCount: 1 });

    expect(Array.from(host.querySelectorAll(".analysis-chart-empty")).map((item) => item.textContent)).toEqual([
      "当前周期暂无支出。",
      "暂无完整周期数据。",
      "暂无完整日数据。",
    ]);
    expect(Array.from(host.querySelectorAll("table caption")).map((item) => item.textContent)).toEqual([
      "当前周期累计支出",
      "完整工资周期支出",
      "每日支出",
    ]);
    expect(host.textContent).not.toContain("记录完整工资周期后显示");
    expect(host.textContent).not.toContain("记录完整日后显示");
  });

  it("uses solid actuals and dashed predictions without a fixed-income reference", async () => {
    const { host } = await renderView({ result: analysis() });

    expect(host.querySelector('[data-chart-series="实际支出"]')?.getAttribute("data-line-style")).toBe("solid");
    expect(host.querySelector('[data-chart-series="预测支出"]')?.getAttribute("data-line-style")).toBe("dashed");
    expect(host.querySelectorAll("[data-reference-line]")).toHaveLength(0);
    expect(host.textContent).toContain("实际支出");
    expect(host.textContent).toContain("预测支出");
    expect(host.textContent).not.toContain("当前月工资");
  });
});
