import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, IncomeForecast, PayCyclePlan } from "../domain";
import { IncomeForecastDialog, type IncomeDialogMode } from "./IncomeForecastDialog";

const dataMocks = vi.hoisted(() => ({
  recordActualIncome: vi.fn(),
  setIncomeForecast: vi.fn(),
}));

vi.mock("../data", () => dataMocks);
vi.mock("./Modal", () => ({
  Modal: ({ open, title, description, children }: { open: boolean; title: string; description?: string; children: ReactNode }) => open
    ? <section aria-label={title}>{description ? <p>{description}</p> : null}{children}</section>
    : null,
}));

const plan: PayCyclePlan = { paydayDay: 15 };

function settings(incomeForecast?: IncomeForecast, lastExpectedIncomeMinor?: number): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    payCycle: plan,
    ...(incomeForecast ? { incomeForecast } : {}),
    ...(lastExpectedIncomeMinor === undefined ? {} : { lastExpectedIncomeMinor }),
    schemaVersion: 1,
    updatedAt: "2026-08-10T04:00:00.000Z",
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
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 10, 12));
  dataMocks.recordActualIncome.mockReset().mockResolvedValue(undefined);
  dataMocks.setIncomeForecast.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function renderDialog(mode: IncomeDialogMode, appSettings: AppSettings | undefined = settings()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  await act(async () => {
    root.render(<IncomeForecastDialog open mode={mode} settings={appSettings} onClose={onClose} onSaved={onSaved} />);
  });
  return { host, onClose, onSaved };
}

async function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLFormElement>("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("IncomeForecastDialog", () => {
  it("uses one expected amount and preloads the last confirmed value", async () => {
    const { host } = await renderDialog("forecast", settings(undefined, 678_90));
    expect(host.querySelector("#minimum-income")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#expected-income")?.value).toBe("678.90");
    expect(host.querySelector<HTMLInputElement>("#income-target-date")?.value).toBe("2026-08-15");
  });

  it("saves a one-time expected income", async () => {
    const { host, onSaved, onClose } = await renderDialog("forecast");
    await fill(host.querySelector<HTMLInputElement>("#expected-income")!, "4567.89");
    await submit(host);
    expect(dataMocks.setIncomeForecast).toHaveBeenCalledWith({
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 456_789,
    });
    expect(onSaved).toHaveBeenCalledWith("预计收入已保存");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows a single delayed date", async () => {
    const { host } = await renderDialog("forecast");
    await fill(host.querySelector<HTMLInputElement>("#income-target-date")!, "2026-08-18");
    await submit(host);
    expect(dataMocks.setIncomeForecast).toHaveBeenCalledWith(expect.objectContaining({ targetPaydayDateKey: "2026-08-18" }));
  });

  it("keeps form values after a save failure", async () => {
    dataMocks.setIncomeForecast.mockRejectedValueOnce(new Error("本机存储空间不足"));
    const { host, onClose } = await renderDialog("forecast");
    const amount = host.querySelector<HTMLInputElement>("#expected-income")!;
    await fill(amount, "5000.00");
    await submit(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("本机存储空间不足");
    expect(amount.value).toBe("5000.00");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("defaults actual income to the expected amount and records it without savings settlement", async () => {
    const forecast: IncomeForecast = { id: "income-1", targetPaydayDateKey: "2026-08-10", expectedIncomeMinor: 432_100 };
    const { host } = await renderDialog("actual", settings(forecast));
    expect(host.querySelector<HTMLInputElement>("#actual-income")?.value).toBe("4321.00");
    expect(host.querySelector("#settlement-savings")).toBeNull();
    await submit(host);
    expect(dataMocks.recordActualIncome).toHaveBeenCalledWith(432_100);
  });

  it("accepts zero actual income without creating a zero ledger entry in the UI layer", async () => {
    const forecast: IncomeForecast = { id: "income-1", targetPaydayDateKey: "2026-08-10", expectedIncomeMinor: 100 };
    const { host, onSaved } = await renderDialog("actual", settings(forecast));
    await fill(host.querySelector<HTMLInputElement>("#actual-income")!, "0");
    await submit(host);
    expect(dataMocks.recordActualIncome).toHaveBeenCalledWith(0);
    expect(onSaved).toHaveBeenCalledWith("本次收入已确认");
  });

  it("requires a pay cycle", async () => {
    const withoutPlan = { ...settings() };
    delete withoutPlan.payCycle;
    const { host } = await renderDialog("forecast", withoutPlan);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请先设置发薪日");
    expect(host.querySelector("form")).toBeNull();
  });
});
