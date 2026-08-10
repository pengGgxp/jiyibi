import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  calculatePayCycleStatus,
  type AppSettings,
  type LedgerSummary,
  type PayCyclePlan,
} from "../domain";
import { SummaryPanel } from "./SummaryPanel";

const summary: LedgerSummary = {
  balanceMinor: 8_000,
  monthIncomeMinor: 10_000,
  monthExpenseMinor: 2_000,
};

const plan: PayCyclePlan = {
  paydayDay: 10,
  monthlySalaryMinor: 100_000,
  cycleEndBalanceGoalMinor: 10_000,
};

function settings(payCycle?: PayCyclePlan, legacyGoal?: number): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(payCycle ? { payCycle } : {}),
    ...(legacyGoal === undefined ? {} : { monthEndBalanceGoalMinor: legacyGoal }),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function renderPanel(balanceMinor: number, payCycle?: PayCyclePlan, legacyGoal?: number): HTMLElement {
  const host = document.createElement("div");
  const appSettings = settings(payCycle, legacyGoal);
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={{ ...summary, balanceMinor }}
      settings={appSettings}
      payCycleStatus={payCycle
        ? calculatePayCycleStatus([], balanceMinor, payCycle, new Date(2026, 7, 10, 12))
        : undefined}
      loading={false}
      onOpenSettings={vi.fn()}
    />,
  );
  return host;
}

describe("SummaryPanel pay cycle", () => {
  it("offers a settings entry when no pay cycle is configured", () => {
    const panel = renderPanel(8_000);

    expect(panel.querySelector(".pay-cycle-card")).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>(".balance-goal-setup")?.textContent)
      .toContain("设置工资周期");
  });

  it("shows payday, salary, period and the exact balance gap", () => {
    const panel = renderPanel(8_000, plan);
    const cycle = panel.querySelector(".pay-cycle-card");

    expect(cycle?.classList.contains("is-behind")).toBe(true);
    expect(cycle?.textContent).toContain("每月 10 日发薪");
    expect(cycle?.textContent).toContain("8月10日—9月9日");
    expect(cycle?.textContent).toContain("每月工资¥1,000.00");
    expect(cycle?.textContent).toContain("当前余额还差 ¥20.00");
    expect(cycle?.textContent).toContain("周期末底线 ¥100.00");
    expect(cycle?.textContent).toContain("当前可再花 ¥0.00");
  });

  it("shows the spendable amount constrained by salary and the balance floor", () => {
    const panel = renderPanel(12_000, plan);
    const cycle = panel.querySelector(".pay-cycle-card");

    expect(cycle?.classList.contains("is-on-track")).toBe(true);
    expect(cycle?.textContent).toContain("当前余额高出 ¥20.00");
    expect(cycle?.textContent).toContain("当前可再花 ¥20.00");
  });

  it("keeps an old natural-month goal visible until the pay cycle is configured", () => {
    const panel = renderPanel(8_000, undefined, 12_345);

    expect(panel.textContent).toContain("旧版自然月底线 ¥123.45");
    expect(panel.textContent).toContain("设置工资周期");
  });
});
