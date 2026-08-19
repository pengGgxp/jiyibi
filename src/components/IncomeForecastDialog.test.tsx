import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, IncomeForecast, PayCyclePlan } from "../domain";
import { IncomeForecastDialog, type IncomeDialogMode } from "./IncomeForecastDialog";

const dataMocks = vi.hoisted(() => ({
  postponeIncomeForecast: vi.fn(),
  recordActualIncomeOnDate: vi.fn(),
  replaceIncomeForecast: vi.fn(),
  setIncomeForecastIfUnchanged: vi.fn(),
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
  dataMocks.postponeIncomeForecast.mockReset().mockResolvedValue(undefined);
  dataMocks.recordActualIncomeOnDate.mockReset().mockResolvedValue(undefined);
  dataMocks.replaceIncomeForecast.mockReset().mockResolvedValue(undefined);
  dataMocks.setIncomeForecastIfUnchanged.mockReset().mockResolvedValue(undefined);
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
  const onModeChange = vi.fn();
  const rerender = async (
    nextMode: IncomeDialogMode = mode,
    nextSettings: AppSettings | undefined = appSettings,
  ) => {
    await act(async () => {
      root.render(
        <IncomeForecastDialog
          open
          mode={nextMode}
          settings={nextSettings}
          onClose={onClose}
          onModeChange={onModeChange}
          onSaved={onSaved}
        />,
      );
    });
  };
  await rerender();
  return { host, onClose, onModeChange, onSaved, rerender };
}

async function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function submit(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLFormElement>("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("IncomeForecastDialog", () => {
  it("uses one expected amount and preloads the last confirmed value", async () => {
    const { host } = await renderDialog("forecast", settings(undefined, 678_90));
    expect(host.querySelector("#minimum-income")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#expected-income")?.value).toBe("678.90");
    expect(host.querySelector<HTMLInputElement>('input[value="regular"]')?.checked).toBe(true);
    expect(host.textContent).toContain("8月15日");
    expect(host.querySelector("#income-target-date")).toBeNull();
  });

  it("saves a one-time expected income", async () => {
    const { host, onSaved, onClose } = await renderDialog("forecast");
    await fill(host.querySelector<HTMLInputElement>("#expected-income")!, "4567.89");
    await submit(host);
    expect(dataMocks.setIncomeForecastIfUnchanged).toHaveBeenCalledWith(
      {
        targetPaydayDateKey: "2026-08-15",
        expectedIncomeMinor: 456_789,
      },
      null,
    );
    expect(onSaved).toHaveBeenCalledWith("预计收入已保存");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows a single delayed date", async () => {
    const { host } = await renderDialog("forecast");
    await click(host.querySelector<HTMLInputElement>('input[value="custom"]')!);
    await fill(host.querySelector<HTMLInputElement>("#income-target-date")!, "2026-08-18");
    await submit(host);
    expect(dataMocks.setIncomeForecastIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ targetPaydayDateKey: "2026-08-18" }),
      null,
    );
  });

  it("edits an upcoming forecast against the state shown when opened", async () => {
    const upcomingForecast: IncomeForecast = {
      id: "income-upcoming",
      targetPaydayDateKey: "2026-08-14",
      expectedIncomeMinor: 500_000,
    };
    const { host } = await renderDialog("forecast", settings(upcomingForecast));
    await fill(host.querySelector<HTMLInputElement>("#expected-income")!, "5200.00");
    await submit(host);

    expect(dataMocks.setIncomeForecastIfUnchanged).toHaveBeenCalledWith(
      {
        targetPaydayDateKey: "2026-08-14",
        expectedIncomeMinor: 520_000,
      },
      upcomingForecast,
    );
  });

  it("moves an already-due forecast to the next regular payday as a new occurrence", async () => {
    vi.setSystemTime(new Date(2026, 7, 15, 12));
    const dueForecast: IncomeForecast = {
      id: "income-due",
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 500_000,
    };
    const { host } = await renderDialog("forecast", settings(dueForecast));

    expect(host.textContent).toContain("今天到账");
    expect(host.textContent).toContain("设为下次将结束本次");
    expect(host.textContent).toContain("9月15日");
    expect(host.querySelector<HTMLInputElement>('input[value="regular"]')?.checked).toBe(true);

    await click(host.querySelector<HTMLInputElement>('input[value="custom"]')!);
    const customDate = host.querySelector<HTMLInputElement>("#income-target-date")!;
    expect(customDate.min).toBe("2026-08-16");
    expect(customDate.max).toBe("2026-10-14");
    await click(host.querySelector<HTMLInputElement>('input[value="regular"]')!);
    await submit(host);

    expect(dataMocks.replaceIncomeForecast).toHaveBeenCalledWith(
      {
        targetPaydayDateKey: "2026-09-15",
        expectedIncomeMinor: 500_000,
      },
      dueForecast,
    );
    expect(dataMocks.setIncomeForecastIfUnchanged).not.toHaveBeenCalled();
  });

  it("opens an overdue reminder directly in postponement mode", async () => {
    vi.setSystemTime(new Date(2026, 7, 16, 12));
    const overdueForecast: IncomeForecast = {
      id: "income-overdue",
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 500_000,
    };
    const { host } = await renderDialog("postpone", settings(overdueForecast));
    const dateInput = host.querySelector<HTMLInputElement>("#income-target-date")!;

    expect(dateInput.value).toBe("2026-08-16");
    expect(dateInput.max).toBe("2026-09-14");
    expect(dateInput.hasAttribute("data-autofocus")).toBe(true);
    expect(host.textContent).toContain("不改常规日");
    expect(host.querySelector("#expected-income")).toBeNull();
    await fill(dateInput, "2026-08-18");
    await submit(host);
    expect(dataMocks.postponeIncomeForecast).toHaveBeenCalledWith(
      "2026-08-18",
      overdueForecast,
    );
    expect(dataMocks.setIncomeForecastIfUnchanged).not.toHaveBeenCalled();
    expect(dataMocks.replaceIncomeForecast).not.toHaveBeenCalled();
  });

  it("does not default a last-cycle-day postponement into the next income", async () => {
    vi.setSystemTime(new Date(2026, 8, 14, 12));
    const lastDayForecast: IncomeForecast = {
      id: "income-last-day",
      targetPaydayDateKey: "2026-09-14",
      expectedIncomeMinor: 500_000,
    };
    const { host, onModeChange } = await renderDialog("postpone", settings(lastDayForecast));
    expect(host.querySelector("#income-target-date")).toBeNull();
    expect(host.textContent).toContain("本次已跨期，请先确认收入");
    await click(Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("设为下次"))!);
    expect(onModeChange).toHaveBeenCalledWith("forecast");
  });

  it("keeps the forecast snapshot when settings change while open", async () => {
    vi.setSystemTime(new Date(2026, 7, 16, 12));
    const openedForecast: IncomeForecast = {
      id: "income-opened",
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 500_000,
    };
    const { host, rerender } = await renderDialog("postpone", settings(openedForecast));
    await rerender("postpone", settings({
      id: "income-remote",
      targetPaydayDateKey: "2026-09-15",
      expectedIncomeMinor: 900_000,
    }));
    await fill(host.querySelector<HTMLInputElement>("#income-target-date")!, "2026-08-18");
    await submit(host);

    expect(dataMocks.postponeIncomeForecast).toHaveBeenCalledWith(
      "2026-08-18",
      openedForecast,
    );
  });

  it("keeps form values after a save failure", async () => {
    dataMocks.setIncomeForecastIfUnchanged.mockRejectedValueOnce(new Error("本机存储空间不足"));
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
    expect(dataMocks.recordActualIncomeOnDate).toHaveBeenCalledWith(
      432_100,
      "2026-08-10",
      forecast,
    );
  });

  it("defaults an overdue actual income to today's arrival date", async () => {
    vi.setSystemTime(new Date(2026, 7, 18, 12));
    const forecast: IncomeForecast = {
      id: "income-1",
      targetPaydayDateKey: "2026-08-15",
      expectedIncomeMinor: 432_100,
    };
    const { host } = await renderDialog("actual", settings(forecast));
    const dateInput = host.querySelector<HTMLInputElement>("#income-target-date")!;
    expect(dateInput.value).toBe("2026-08-18");
    expect(dateInput.min).toBe("2026-08-15");
    expect(dateInput.max).toBe("2026-08-18");
    await submit(host);
    expect(dataMocks.recordActualIncomeOnDate).toHaveBeenCalledWith(
      432_100,
      "2026-08-18",
      forecast,
    );
  });

  it("accepts zero actual income without creating a zero ledger entry in the UI layer", async () => {
    const forecast: IncomeForecast = { id: "income-1", targetPaydayDateKey: "2026-08-10", expectedIncomeMinor: 100 };
    const { host, onSaved } = await renderDialog("actual", settings(forecast));
    await fill(host.querySelector<HTMLInputElement>("#actual-income")!, "0");
    await submit(host);
    expect(dataMocks.recordActualIncomeOnDate).toHaveBeenCalledWith(
      0,
      "2026-08-10",
      forecast,
    );
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
