import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../domain";
import type { PwaState } from "../hooks/usePwa";
import type { CloudSyncSectionProps } from "./CloudSyncSection";
import { SettingsDialog } from "./SettingsDialog";

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

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

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

async function renderDialog(
  linked: boolean,
  appSettings?: AppSettings,
  cloudOverride?: CloudSyncSectionProps,
): Promise<{
  host: HTMLElement;
  render(open: boolean, nextSettings?: AppSettings): Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const render = async (open: boolean, nextSettings = appSettings) => {
    await act(async () => {
      root.render(
        <SettingsDialog
          open={open}
          settings={nextSettings}
          pwa={pwa}
          cloudSync={cloudOverride ?? cloudSync(linked)}
          onClose={vi.fn()}
          onDataChanged={vi.fn()}
        />,
      );
    });
  };
  await render(true);
  return { host, render };
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

describe("SettingsDialog month-end balance goal", () => {
  it("defaults the goal to off and keeps its amount input disabled", async () => {
    const { host: dialog } = await renderDialog(false, settings());
    const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]');
    const amount = dialog.querySelector<HTMLInputElement>("#month-end-balance-goal");

    expect(toggle?.checked).toBe(false);
    expect(amount?.disabled).toBe(true);
    expect(amount?.value).toBe("0.00");
  });

  it("reflects an enabled goal and its signed amount", async () => {
    const { host: dialog } = await renderDialog(false, settings(-12_345));
    const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]');
    const amount = dialog.querySelector<HTMLInputElement>("#month-end-balance-goal");

    expect(toggle?.checked).toBe(true);
    expect(amount?.disabled).toBe(false);
    expect(amount?.value).toBe("-123.45");
  });

  it("restores the saved goal after closing with unsaved edits", async () => {
    const saved = settings(12_345);
    const { host: dialog, render } = await renderDialog(false, saved);
    const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]')!;
    const amount = dialog.querySelector<HTMLInputElement>("#month-end-balance-goal")!;

    await act(async () => {
      toggle.click();
      amount.value = "999.99";
      amount.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(false, saved);
    await render(true, saved);

    expect(dialog.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>("#month-end-balance-goal")?.value).toBe("123.45");
  });

  it("discloses every local data type before cloud sync is enabled", async () => {
    const ready = cloudSync(false);
    ready.phase = "ready";
    ready.localEntryCount = 3;
    ready.localAttachmentCount = 2;
    const { host: dialog } = await renderDialog(false, settings(), ready);

    expect(dialog.textContent).toContain("3 笔记录");
    expect(dialog.textContent).toContain("账本设置（初始余额和月末余额底线）");
    expect(dialog.textContent).toContain("2 张截图");
  });
});
