import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, IncomeForecast } from "../domain";
import type { PwaState } from "../hooks/usePwa";
import type { CloudSyncSectionProps } from "./CloudSyncSection";
import { SettingsDialog } from "./SettingsDialog";

const dataMocks = vi.hoisted(() => ({
  setInitialSavings: vi.fn(),
  setPayCyclePlan: vi.fn(),
}));

vi.mock("../data", async (importOriginal) => ({
  ...await importOriginal<typeof import("../data")>(),
  ...dataMocks,
}));
vi.mock("./Modal", () => ({ Modal: ({ open, children }: { open: boolean; children: ReactNode }) => open ? children : null }));
vi.mock("../hooks/useStorageEstimate", () => ({
  useStorageEstimate: () => ({ estimate: undefined, error: false, refresh: async () => undefined }),
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

function settings(incomeForecast?: IncomeForecast): AppSettings {
  return {
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    payCycle: { paydayDay: 10 },
    savingsGoal: { targetDateKey: "2026-12-31", targetMinor: 100_000 },
    ...(incomeForecast ? { incomeForecast } : {}),
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
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
  dataMocks.setInitialSavings.mockReset().mockResolvedValue(undefined);
  dataMocks.setPayCyclePlan.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

async function renderDialog(linked: boolean, appSettings: AppSettings = settings(), openingSavingsMinor = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onOpenIncomeForecast = vi.fn();
  await act(async () => root.render(
    <SettingsDialog
      open
      settings={appSettings}
      openingSavingsMinor={openingSavingsMinor}
      pwa={pwa}
      cloudSync={cloudSync(linked)}
      onClose={vi.fn()}
      onDataChanged={vi.fn()}
      onOpenIncomeForecast={onOpenIncomeForecast}
      onOpenBalance={vi.fn()}
      onOpenSavingsGoal={vi.fn()}
    />,
  ));
  return { host, onOpenIncomeForecast };
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

describe("SettingsDialog", () => {
  it("keeps restore unavailable for a cloud-linked ledger", async () => {
    const { host } = await renderDialog(true);
    await click(host, "数据");
    expect(host.querySelector<HTMLButtonElement>('button[aria-describedby="restore-unavailable-reason"]')?.disabled).toBe(true);
    expect(host.querySelector("#restore-file")).toBeNull();
    expect(host.querySelector("#restore-unavailable-reason")).not.toBeNull();
  });

  it("keeps restore available for a local-only ledger", async () => {
    const { host } = await renderDialog(false);
    await click(host, "数据");
    expect(host.querySelector<HTMLInputElement>("#restore-file")?.disabled).toBe(false);
    expect(host.querySelector("#restore-unavailable-reason")).toBeNull();
  });

  it("shows only the recurring payday in the pay-cycle form", async () => {
    const { host } = await renderDialog(false);
    expect(host.querySelector<HTMLInputElement>("#payday-day")?.value).toBe("10");
    expect(host.querySelector("#default-savings-target")).toBeNull();
    expect(host.querySelector("#cycle-savings-target")).toBeNull();
    expect(host.textContent).not.toContain("每周期默认留存目标");
  });

  it("saves only the payday", async () => {
    const { host } = await renderDialog(false);
    await fill(host.querySelector<HTMLInputElement>("#payday-day")!, "18");
    await click(host, "保存发薪日");
    expect(dataMocks.setPayCyclePlan).toHaveBeenCalledWith({ paydayDay: 18 });
  });

  it("labels opening retained money as existing savings", async () => {
    const { host } = await renderDialog(false, settings(), 34_567);
    expect(host.querySelector<HTMLInputElement>("#initial-savings")?.value).toBe("345.67");
    expect(host.textContent).toContain("已有存款");
    expect(host.textContent).toContain("保存存款");
    expect(host.textContent).not.toContain("初始留存");
  });

  it("keeps the savings input after a storage failure", async () => {
    dataMocks.setInitialSavings.mockRejectedValueOnce(new Error("已有存款不能超过总余额"));
    const { host } = await renderDialog(false);
    const input = host.querySelector<HTMLInputElement>("#initial-savings")!;
    await fill(input, "800.00");
    await click(host, "保存存款");
    expect(input.value).toBe("800.00");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("已有存款不能超过总余额");
  });

  it("shows one expected income and opens its editor", async () => {
    const forecast: IncomeForecast = { id: "forecast-1", targetPaydayDateKey: "2026-09-10", expectedIncomeMinor: 800_000 };
    const { host, onOpenIncomeForecast } = await renderDialog(false, settings(forecast));
    expect(host.textContent).toContain("¥8,000.00");
    expect(host.textContent).not.toContain("最低收入");
    await click(host, "修改预计");
    expect(onOpenIncomeForecast).toHaveBeenCalledOnce();
  });
});
