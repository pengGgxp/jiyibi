import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../domain";
import { SavingsGoalDialog } from "./SavingsGoalDialog";

const dataMocks = vi.hoisted(() => ({ clearSavingsGoal: vi.fn(), setSavingsGoal: vi.fn() }));
vi.mock("../data", () => dataMocks);
vi.mock("./Modal", () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open
    ? <section aria-label={title}>{children}</section>
    : null,
}));

const settings: AppSettings = {
  id: "primary",
  currency: "CNY",
  initialBalanceMinor: 0,
  savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 1_000_000 },
  schemaVersion: 1,
  updatedAt: "2026-08-10T00:00:00.000Z",
};

const roots: Root[] = [];
const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { reactEnv.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => {
  if (previousAct === undefined) Reflect.deleteProperty(reactEnv, "IS_REACT_ACT_ENVIRONMENT");
  else reactEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 19, 12));
  dataMocks.clearSavingsGoal.mockReset().mockResolvedValue(undefined);
  dataMocks.setSavingsGoal.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function renderDialog(appSettings: AppSettings = settings) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  await act(async () => root.render(
    <SavingsGoalDialog open settings={appSettings} onClose={onClose} onSaved={onSaved} />,
  ));
  return { host, onClose, onSaved };
}

async function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function click(host: HTMLElement, text: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => { button.click(); await Promise.resolve(); });
}

describe("SavingsGoalDialog", () => {
  it("edits a cumulative amount and date", async () => {
    const { host, onSaved, onClose } = await renderDialog();
    expect(host.querySelector<HTMLInputElement>("#savings-goal-amount")?.value).toBe("10000.00");
    expect(host.querySelector<HTMLInputElement>("#savings-goal-date")?.value).toBe("2026-12-31");
    await fill(host.querySelector<HTMLInputElement>("#savings-goal-amount")!, "12000.00");
    await fill(host.querySelector<HTMLInputElement>("#savings-goal-date")!, "2027-01-31");
    await click(host, "保存目标");
    expect(dataMocks.setSavingsGoal).toHaveBeenCalledWith({ targetDateKey: "2027-01-31", targetMinor: 1_200_000 });
    expect(onSaved).toHaveBeenCalledWith("目标已更新");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation before clearing the goal", async () => {
    const { host, onSaved } = await renderDialog();
    await click(host, "清除目标");
    expect(dataMocks.clearSavingsGoal).not.toHaveBeenCalled();
    expect(host.textContent).toContain("存钱记录会保留");
    await click(host, "确认清除");
    expect(dataMocks.clearSavingsGoal).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith("目标已清除");
  });

  it("keeps invalid form data visible", async () => {
    const { host, onClose } = await renderDialog();
    const amount = host.querySelector<HTMLInputElement>("#savings-goal-amount")!;
    await fill(amount, "0");
    await click(host, "保存目标");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("目标额需大于 0");
    expect(amount.value).toBe("0");
    expect(onClose).not.toHaveBeenCalled();
  });
});
