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
  Modal: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    children: ReactNode;
  }) => open ? (
    <section aria-label={title}>
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ) : null,
}));

const plan: PayCyclePlan = {
  paydayDay: 15,
  cycleEndBalanceGoalMinor: 100_000,
};

function settings(
  payCycle: PayCyclePlan | null = plan,
  incomeForecast?: IncomeForecast,
): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(payCycle ? { payCycle } : {}),
    ...(incomeForecast ? { incomeForecast } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T04:00:00.000Z",
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 10, 12));
  dataMocks.recordActualIncome.mockReset().mockResolvedValue(undefined);
  dataMocks.setIncomeForecast.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function renderDialog(
  mode: IncomeDialogMode,
  appSettings: AppSettings | undefined = settings(),
): Promise<{
  host: HTMLElement;
  onClose: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onClose = vi.fn();
  const onSaved = vi.fn();

  await act(async () => {
    root.render(
      <IncomeForecastDialog
        open
        mode={mode}
        settings={appSettings}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
  });

  return { host, onClose, onSaved };
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setInputValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setInputValue) throw new Error("HTML input value setter is unavailable");

  await act(async () => {
    setInputValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(host: HTMLElement): Promise<void> {
  const form = host.querySelector<HTMLFormElement>("form");
  if (!form) throw new Error("Income form was not rendered");

  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("IncomeForecastDialog forecast mode", () => {
  it("starts a new forecast at zero and restores values for the same target payday", async () => {
    const fresh = await renderDialog("forecast");

    expect(fresh.host.querySelector<HTMLInputElement>("#minimum-income")?.value).toBe("0.00");
    expect(fresh.host.querySelector<HTMLInputElement>("#expected-income")?.value).toBe("0.00");

    const existing: IncomeForecast = {
      id: "forecast-1",
      targetPaydayDateKey: "2026-08-15",
      minimumIncomeMinor: 123_45,
      expectedIncomeMinor: 678_90,
    };
    const edit = await renderDialog("forecast", settings(plan, existing));

    expect(edit.host.querySelector<HTMLInputElement>("#minimum-income")?.value).toBe("123.45");
    expect(edit.host.querySelector<HTMLInputElement>("#expected-income")?.value).toBe("678.90");
  });

  it("rejects negative income", async () => {
    const { host, onClose, onSaved } = await renderDialog("forecast");
    const minimum = host.querySelector<HTMLInputElement>("#minimum-income")!;

    await changeInput(minimum, "-1.00");
    await submit(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toBe("收入不能小于 0");
    expect(minimum.value).toBe("-1.00");
    expect(dataMocks.setIncomeForecast).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects a minimum income above the expected income", async () => {
    const { host } = await renderDialog("forecast");
    const minimum = host.querySelector<HTMLInputElement>("#minimum-income")!;
    const expected = host.querySelector<HTMLInputElement>("#expected-income")!;

    await changeInput(minimum, "200.00");
    await changeInput(expected, "100.00");
    await submit(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toBe("最低收入不能高于预计收入");
    expect(dataMocks.setIncomeForecast).not.toHaveBeenCalled();
  });

  it("saves minor-unit values against the next payday", async () => {
    const { host, onClose, onSaved } = await renderDialog("forecast");

    await changeInput(host.querySelector<HTMLInputElement>("#minimum-income")!, "123.45");
    await changeInput(host.querySelector<HTMLInputElement>("#expected-income")!, "678.90");
    await submit(host);

    expect(dataMocks.setIncomeForecast).toHaveBeenCalledOnce();
    expect(dataMocks.setIncomeForecast).toHaveBeenCalledWith({
      targetPaydayDateKey: "2026-08-15",
      minimumIncomeMinor: 12_345,
      expectedIncomeMinor: 67_890,
    });
    expect(onSaved).toHaveBeenCalledWith("下次收入预期已保存");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("retains entered values when saving fails", async () => {
    dataMocks.setIncomeForecast.mockRejectedValueOnce(new Error("本机存储空间不足"));
    const { host, onClose, onSaved } = await renderDialog("forecast");
    const minimum = host.querySelector<HTMLInputElement>("#minimum-income")!;
    const expected = host.querySelector<HTMLInputElement>("#expected-income")!;

    await changeInput(minimum, "3000.00");
    await changeInput(expected, "5000.00");
    await submit(host);

    expect(host.querySelector('[role="alert"]')?.textContent).toBe("本机存储空间不足");
    expect(minimum.value).toBe("3000.00");
    expect(expected.value).toBe("5000.00");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("IncomeForecastDialog actual mode", () => {
  const existing: IncomeForecast = {
    id: "forecast-actual",
    targetPaydayDateKey: "2026-08-10",
    minimumIncomeMinor: 300_000,
    expectedIncomeMinor: 432_100,
  };

  it("defaults the actual amount to the expected income", async () => {
    const { host } = await renderDialog("actual", settings(plan, existing));

    expect(host.querySelector<HTMLInputElement>("#actual-income")?.value).toBe("4321.00");
  });

  it.each([
    ["0", 0, "本次收入已确认为 ¥0.00"],
    ["4567.89", 456_789, "实际收入已记入余额"],
  ])("records actual input %s", async (input, expectedMinor, message) => {
    const { host, onClose, onSaved } = await renderDialog("actual", settings(plan, existing));
    await changeInput(host.querySelector<HTMLInputElement>("#actual-income")!, input);

    await submit(host);

    expect(dataMocks.recordActualIncome).toHaveBeenCalledOnce();
    expect(dataMocks.recordActualIncome).toHaveBeenCalledWith(expectedMinor);
    expect(onSaved).toHaveBeenCalledWith(message);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("IncomeForecastDialog plan requirements", () => {
  it("shows setup guidance and no form when the pay-cycle plan is missing", async () => {
    const { host } = await renderDialog("forecast", settings(null));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "请先在设置中填写发薪日和周期底线",
    );
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector("#minimum-income")).toBeNull();
    expect(dataMocks.setIncomeForecast).not.toHaveBeenCalled();
    expect(dataMocks.recordActualIncome).not.toHaveBeenCalled();
  });
});
