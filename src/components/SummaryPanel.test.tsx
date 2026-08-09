import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, LedgerSummary } from "../domain";
import { SummaryPanel } from "./SummaryPanel";

const summary: LedgerSummary = {
  balanceMinor: 8_000,
  monthIncomeMinor: 10_000,
  monthExpenseMinor: 2_000,
};

function settings(monthEndBalanceGoalMinor?: number): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(monthEndBalanceGoalMinor === undefined ? {} : { monthEndBalanceGoalMinor }),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function renderPanel(
  balanceMinor: number,
  monthEndBalanceGoalMinor?: number,
): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SummaryPanel
      summary={{ ...summary, balanceMinor }}
      settings={settings(monthEndBalanceGoalMinor)}
      loading={false}
      onOpenSettings={vi.fn()}
    />,
  );
  return host;
}

describe("SummaryPanel month-end balance goal", () => {
  it("offers a settings entry when no goal is configured", () => {
    const panel = renderPanel(8_000);

    expect(panel.querySelector(".balance-goal")).toBeNull();
    expect(panel.querySelector<HTMLButtonElement>(".balance-goal-setup")?.textContent)
      .toContain("设置月末余额底线");
  });

  it("shows the remaining amount when the current balance is below the goal", () => {
    const panel = renderPanel(8_000, 10_000);
    const goal = panel.querySelector(".balance-goal");

    expect(goal?.classList.contains("is-behind")).toBe(true);
    expect(goal?.textContent).toContain("本月余额底线¥100.00");
    expect(goal?.textContent).toContain("当前还差 ¥20.00");
  });

  it("states when the current balance exactly reaches the goal", () => {
    const panel = renderPanel(10_000, 10_000);
    const goal = panel.querySelector(".balance-goal");

    expect(goal?.classList.contains("is-on-track")).toBe(true);
    expect(goal?.textContent).toContain("当前正好达到底线");
  });

  it("shows the surplus when the current balance is above the goal", () => {
    const panel = renderPanel(12_000, 10_000);
    const goal = panel.querySelector(".balance-goal");

    expect(goal?.classList.contains("is-on-track")).toBe(true);
    expect(goal?.textContent).toContain("当前高出 ¥20.00");
  });
});
