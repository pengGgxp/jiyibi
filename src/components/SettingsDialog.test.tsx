import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, IncomeForecast, PayCyclePlan } from "../domain";
import type { PwaState } from "../hooks/usePwa";
import type { CloudSyncSectionProps } from "./CloudSyncSection";
import { SettingsDialog } from "./SettingsDialog";

const dataMocks = vi.hoisted(() => ({
  setInitialSavings: vi.fn(),
  setPayCyclePlan: vi.fn(),
  setSavingsTargetOverride: vi.fn(),
}));

vi.mock("../data", async (importOriginal) => ({
  ...await importOriginal<typeof import("../data")>(),
  ...dataMocks,
}));

vi.mock("./Modal", () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null,
}));

vi.mock("../hooks/useStorageEstimate", () => ({
  useStorageEstimate: () => ({
    estimate: undefined,
    error: false,
    refresh: async () => undefined,
  }),
}));

const pwa: PwaState = {
  online: true,
  installed: false,
  canInstall: false,
  needRefresh: false,
  offlineReady: false,
  install: async () => false,
  update: async () => undefined,
  dismissUpdate: vi.fn(),
  dismissOfflineReady: vi.fn(),
};

function cloudSync(linked: boolean): CloudSyncSectionProps {
  return {
    phase: linked ? "synced" : "signed-out",
    linked,
    pendingCount: 0,
    localEntryCount: 0,
    localAttachmentCount: 0,
    conflicts: [],
    loginUrl: "/api/login",
    logoutUrl: "/api/logout?returnTo=%2F",
    canDeleteCloudData: linked,
    deletionBusy: false,
    loadAttachment: vi.fn().mockResolvedValue(undefined),
    onEnable: vi.fn(),
    onRetry: vi.fn(),
    onDeleteCloudData: vi.fn(),
    onResolveConflict: vi.fn(),
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
  dataMocks.setInitialSavings.mockReset().mockResolvedValue(undefined);
  dataMocks.setPayCyclePlan.mockReset().mockResolvedValue(undefined);
  dataMocks.setSavingsTargetOverride.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function settings(
  payCycle?: PayCyclePlan,
  legacyGoal?: number,
  incomeForecast?: IncomeForecast,
): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    ...(payCycle ? { payCycle } : {}),
    ...(legacyGoal === undefined ? {} : { monthEndBalanceGoalMinor: legacyGoal }),
    ...(incomeForecast ? { incomeForecast } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

async function renderDialog(
  linked: boolean,
  appSettings?: AppSettings,
  cloudOverride?: CloudSyncSectionProps,
  openingSavingsMinor = 0,
): Promise<{
  host: HTMLElement;
  onOpenIncomeForecast: ReturnType<typeof vi.fn>;
  render(open: boolean, nextSettings?: AppSettings): Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onOpenIncomeForecast = vi.fn();
  const render = async (open: boolean, nextSettings = appSettings) => {
    await act(async () => {
      root.render(
        <SettingsDialog
          open={open}
          settings={nextSettings}
          openingSavingsMinor={openingSavingsMinor}
          pwa={pwa}
          cloudSync={cloudOverride ?? cloudSync(linked)}
          onClose={vi.fn()}
          onDataChanged={vi.fn()}
          onOpenIncomeForecast={onOpenIncomeForecast}
        />,
      );
    });
  };
  await render(true);
  return { host, onOpenIncomeForecast, render };
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("HTML input value setter is unavailable");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(host: HTMLElement, label: string): Promise<void> {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe("SettingsDialog backup restore", () => {
  it("disables restore and explains the recovery path for a cloud-linked ledger", async () => {
    const { host: dialog } = await renderDialog(true);
    const trigger = dialog.querySelector<HTMLButtonElement>(
      'button[aria-describedby="restore-unavailable-reason"]',
    );

    expect(trigger?.disabled).toBe(true);
    expect(dialog.querySelector("#restore-file")).toBeNull();
    expect(dialog.querySelector("#restore-unavailable-reason")?.textContent).toContain(
      "当前账本已连接云同步，暂不能恢复备份",
    );
    expect(dialog.querySelector("#restore-unavailable-reason")?.textContent).toContain(
      "请使用尚未连接云同步的浏览器",
    );
  });

  it("keeps the restore form available for a local-only ledger", async () => {
    const { host: dialog } = await renderDialog(false);

    expect(dialog.querySelector<HTMLInputElement>("#restore-file")?.disabled).toBe(false);
    expect(dialog.querySelector("#restore-unavailable-reason")).toBeNull();
    expect(dialog.textContent).not.toContain("删除云端副本");
    expect(dialog.textContent).toContain("使用 GitHub 登录");
  });

  it("keeps cloud deletion separate from signing out", async () => {
    const { host: dialog } = await renderDialog(true);

    expect(dialog.textContent).toContain("退出云端会话");
    expect(dialog.textContent).toContain("删除云端副本");
    expect(dialog.querySelector<HTMLAnchorElement>('a[href^="/api/logout"]')?.href).toContain(
      "/api/logout?returnTo=%2F",
    );
  });
});

describe("SettingsDialog pay cycle", () => {
  const plan: PayCyclePlan = {
    paydayDay: 10,
    defaultSavingsTargetMinor: 12_345,
  };

  it("defaults the plan to off and keeps all inputs disabled", async () => {
    const { host: dialog } = await renderDialog(false, settings());
    const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]');
    const payday = dialog.querySelector<HTMLInputElement>("#payday-day");
    const goal = dialog.querySelector<HTMLInputElement>("#default-savings-target");

    expect(toggle?.checked).toBe(false);
    expect(payday?.disabled).toBe(true);
    expect(goal?.disabled).toBe(true);
    expect(payday?.value).toBe("1");
    expect(goal?.value).toBe("0.00");
    expect(dialog.querySelector("#monthly-salary")).toBeNull();
  });

  it("reflects an enabled plan including payday and default savings target", async () => {
    const { host: dialog } = await renderDialog(false, settings(plan));
    const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]');

    expect(toggle?.checked).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>("#payday-day")?.value).toBe("10");
    expect(dialog.querySelector<HTMLInputElement>("#default-savings-target")?.value)
      .toBe("123.45");
    expect(dialog.querySelector("#monthly-salary")).toBeNull();
  });

  it("prefills initial savings and the one-cycle savings target independently", async () => {
    const configured: AppSettings = {
      ...settings(plan),
      savingsTargetOverride: {
        targetPaydayDateKey: "2026-09-10",
        targetMinor: 23_456,
      },
    };
    const { host: dialog } = await renderDialog(false, configured, undefined, 34_567);

    expect(dialog.querySelector<HTMLInputElement>("#initial-savings")?.value).toBe("345.67");
    expect(dialog.querySelector<HTMLInputElement>("#cycle-savings-target")?.value)
      .toBe("234.56");
    expect(dialog.textContent).toContain("留空使用默认目标");
  });

  it("saves a non-negative default target and associates negative errors with that field", async () => {
    const { host: dialog } = await renderDialog(false, settings(plan));
    const target = dialog.querySelector<HTMLInputElement>("#default-savings-target")!;

    await changeInput(target, "-1.00");
    await clickButton(dialog, "保存发薪周期");

    expect(dialog.querySelector("#default-savings-target-error")?.textContent)
      .toBe("默认留存目标不能小于 0");
    expect(target.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.querySelector<HTMLInputElement>("#payday-day")?.getAttribute("aria-invalid"))
      .toBe("false");
    expect(dataMocks.setPayCyclePlan).not.toHaveBeenCalled();

    await changeInput(target, "456.78");
    await clickButton(dialog, "保存发薪周期");
    expect(dataMocks.setPayCyclePlan).toHaveBeenCalledWith({
      paydayDay: 10,
      defaultSavingsTargetMinor: 45_678,
    });
  });

  it("saves initial savings, retaining the input when storage rejects it", async () => {
    dataMocks.setInitialSavings.mockRejectedValueOnce(new Error("初始留存不能超过总余额"));
    const { host: dialog } = await renderDialog(false, settings(plan));
    const input = dialog.querySelector<HTMLInputElement>("#initial-savings")!;

    await changeInput(input, "800.00");
    await clickButton(dialog, "保存初始留存");

    expect(dataMocks.setInitialSavings).toHaveBeenCalledWith(80_000);
    expect(input.value).toBe("800.00");
    expect(dialog.querySelector("#initial-savings-error")?.textContent)
      .toBe("初始留存不能超过总余额");
  });

  it("clears the current-cycle override when its optional input is empty", async () => {
    const configured: AppSettings = {
      ...settings(plan),
      savingsTargetOverride: {
        targetPaydayDateKey: "2026-09-10",
        targetMinor: 23_456,
      },
    };
    const { host: dialog } = await renderDialog(false, configured);
    const input = dialog.querySelector<HTMLInputElement>("#cycle-savings-target")!;

    await changeInput(input, "");
    await clickButton(dialog, "保存本周期目标");

    expect(dataMocks.setSavingsTargetOverride).toHaveBeenCalledWith(undefined);
    expect(dialog.textContent).toContain("本周期改用默认目标");
  });

  it("keeps unsaved plan edits when settings refresh while the dialog stays open", async () => {
    const saved = settings(plan);
    const { host: dialog, render } = await renderDialog(false, saved);
    const goal = dialog.querySelector<HTMLInputElement>("#default-savings-target")!;
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setInputValue.call(goal, "999.99");
      goal.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(true, { ...saved, initialBalanceMinor: 12_345 });

    expect(dialog.querySelector<HTMLInputElement>("#default-savings-target")?.value)
      .toBe("999.99");
  });

  it("restores the saved plan after closing with unsaved edits", async () => {
    const saved = settings(plan);
    const { host: dialog, render } = await renderDialog(false, saved);
    const goal = dialog.querySelector<HTMLInputElement>("#default-savings-target")!;
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setInputValue.call(goal, "999.99");
      goal.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(false, saved);
    await render(true, saved);

    expect(dialog.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>("#payday-day")?.value).toBe("10");
    expect(dialog.querySelector<HTMLInputElement>("#default-savings-target")?.value)
      .toBe("123.45");
  });

  it("shows the one-time income forecast separately and opens its editor", async () => {
    const forecast: IncomeForecast = {
      id: "forecast-1",
      targetPaydayDateKey: "2026-09-10",
      minimumIncomeMinor: 500_000,
      expectedIncomeMinor: 800_000,
    };
    const { host: dialog, onOpenIncomeForecast } = await renderDialog(
      false,
      settings(plan, undefined, forecast),
    );
    const trigger = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("修改收入预期"));

    expect(dialog.textContent).toContain("最低 ¥5,000.00 · 预计 ¥8,000.00");
    expect(trigger).toBeDefined();
    await act(async () => trigger?.click());
    expect(onOpenIncomeForecast).toHaveBeenCalledOnce();
  });

  it("prefills the default savings target from a legacy natural-month goal", async () => {
    const { host: dialog } = await renderDialog(false, settings(undefined, 12_345));

    expect(dialog.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    expect(dialog.querySelector<HTMLInputElement>("#default-savings-target")?.value)
      .toBe("123.45");
  });

  it("discloses every local data type before cloud sync is enabled", async () => {
    const ready = cloudSync(false);
    ready.phase = "ready";
    ready.localEntryCount = 3;
    ready.localAttachmentCount = 2;
    const { host: dialog } = await renderDialog(false, settings(), ready);

    expect(dialog.textContent).toContain("3 笔记录");
    expect(dialog.textContent).toContain("账本设置（初始余额、发薪周期和下次收入预期）");
    expect(dialog.textContent).toContain("2 张截图");
  });
});
