import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PwaState } from "../hooks/usePwa";
import type { CloudSyncSectionProps } from "./CloudSyncSection";
import { SettingsDialog } from "./SettingsDialog";

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

function renderDialog(linked: boolean): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <SettingsDialog
      open
      pwa={pwa}
      cloudSync={cloudSync(linked)}
      onClose={vi.fn()}
      onDataChanged={vi.fn()}
    />,
  );
  return host;
}

describe("SettingsDialog backup restore", () => {
  it("disables restore and explains the recovery path for a cloud-linked ledger", () => {
    const dialog = renderDialog(true);
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

  it("keeps the restore form available for a local-only ledger", () => {
    const dialog = renderDialog(false);

    expect(dialog.querySelector<HTMLInputElement>("#restore-file")?.disabled).toBe(false);
    expect(dialog.querySelector("#restore-unavailable-reason")).toBeNull();
    expect(dialog.textContent).not.toContain("删除云端副本");
    expect(dialog.textContent).toContain("使用 GitHub 登录");
  });

  it("keeps cloud deletion separate from signing out", () => {
    const dialog = renderDialog(true);

    expect(dialog.textContent).toContain("退出云端会话");
    expect(dialog.textContent).toContain("删除云端副本");
    expect(dialog.querySelector<HTMLAnchorElement>('a[href^="/api/logout"]')?.href).toContain(
      "/api/logout?returnTo=%2F",
    );
  });
});
