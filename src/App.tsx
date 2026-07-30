import {
  CircleAlert,
  CheckCircle2,
  CloudOff,
  HardDrive,
  ReceiptText,
  RefreshCw,
  Settings,
  Wifi,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  createEntry,
  purgeDeletedEntries,
  purgeDeletedEntry,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
} from "./data";
import type { EntryDraft, LedgerEntry } from "./domain";
import { EditEntryDialog } from "./components/EditEntryDialog";
import { EntryComposer } from "./components/EntryComposer";
import { RecordList } from "./components/RecordList";
import { SettingsDialog } from "./components/SettingsDialog";
import { SummaryPanel } from "./components/SummaryPanel";
import { UndoToasts, type PendingDeletion } from "./components/UndoToasts";
import { useLedger } from "./hooks/useLedger";
import { usePwa } from "./hooks/usePwa";

interface Notice {
  kind: "success" | "error";
  message: string;
}

function mutationError(reason: unknown, fallback: string): Error {
  const isQuotaExceeded = (error: unknown, seen = new Set<unknown>()): boolean => {
    if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) {
      return false;
    }
    seen.add(error);

    const candidate = error as {
      name?: unknown;
      cause?: unknown;
      inner?: unknown;
      innerException?: unknown;
    };
    return candidate.name === "QuotaExceededError"
      || isQuotaExceeded(candidate.cause, seen)
      || isQuotaExceeded(candidate.inner, seen)
      || isQuotaExceeded(candidate.innerException, seen);
  };

  if (isQuotaExceeded(reason)) {
    return new Error("本机存储空间不足，请删除部分截图或导出备份后重试");
  }
  return new Error(fallback);
}

export default function App() {
  const ledger = useLedger();
  const pwa = usePwa();
  const [editingEntry, setEditingEntry] = useState<LedgerEntry>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState<PendingDeletion[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const deletionTimers = useRef(new Map<string, number>());
  const noticeTimer = useRef<number | undefined>(undefined);

  const showNotice = (next: Notice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), 4_500);
  };

  useEffect(() => {
    void purgeDeletedEntries(new Date()).catch(() => {
      showNotice({ kind: "error", message: "有已删除记录尚未完成清理" });
    });
    const timers = deletionTimers.current;
    return () => {
      window.clearTimeout(noticeTimer.current);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  const create = async (draft: EntryDraft) => {
    try {
      await createEntry(draft);
    } catch (reason) {
      throw mutationError(reason, "没有保存成功，请检查本机存储后重试");
    }
  };

  const saveEdit = async (id: string, draft: EntryDraft) => {
    try {
      await updateEntry(id, draft);
      showNotice({ kind: "success", message: "记录已更新，余额已重算" });
    } catch (reason) {
      throw mutationError(reason, "修改没有保存，请重试");
    }
  };

  const deleteEntry = async (entry: LedgerEntry) => {
    if (deletionTimers.current.has(entry.id)) return;
    try {
      await softDeleteEntry(entry.id);
      setPendingDeletes((current) => [
        ...current,
        { id: entry.id, label: entry.note || "截图记录" },
      ]);
      window.requestAnimationFrame(() => document.getElementById("records-title")?.focus());
      const timer = window.setTimeout(() => {
        deletionTimers.current.delete(entry.id);
        setPendingDeletes((current) => current.filter((item) => item.id !== entry.id));
        void purgeDeletedEntry(entry.id).catch(() => {
          showNotice({ kind: "error", message: "记录已隐藏，但附件清理失败" });
        });
      }, 8_000);
      deletionTimers.current.set(entry.id, timer);
    } catch {
      showNotice({ kind: "error", message: "这笔记录没有删除，请重试" });
    }
  };

  const undoDelete = async (id: string) => {
    const timer = deletionTimers.current.get(id);
    if (timer) window.clearTimeout(timer);
    deletionTimers.current.delete(id);
    try {
      await undoDeleteEntry(id);
      setPendingDeletes((current) => current.filter((item) => item.id !== id));
      showNotice({ kind: "success", message: "记录已恢复" });
      window.requestAnimationFrame(() => document.getElementById("records-title")?.focus());
    } catch {
      setPendingDeletes((current) => current.filter((item) => item.id !== id));
      showNotice({ kind: "error", message: "撤销失败，这笔记录可能已完成删除" });
    }
  };

  const focusComposer = () => {
    const amountInput = document.querySelector<HTMLInputElement>(".composer-panel input[data-autofocus]");
    amountInput?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => amountInput?.focus(), 250);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><ReceiptText aria-hidden="true" /></span>
          <div>
            <h1>记一笔</h1>
            <p>收支随手记</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`local-status ${pwa.online ? "" : "is-offline"}`} aria-live="polite">
            {pwa.online ? <HardDrive aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
            <span>{pwa.online ? "只存本机" : "离线可用"}</span>
          </span>
          <button type="button" className="icon-button header-settings" onClick={() => setSettingsOpen(true)} aria-label="打开设置" title="设置">
            <Settings aria-hidden="true" />
          </button>
        </div>
      </header>

      {!pwa.online ? (
        <div className="network-banner" role="status">
          <CloudOff aria-hidden="true" /> 当前离线，仍可查看和记录本机账目。
        </div>
      ) : null}

      {pwa.needRefresh ? (
        <div className="update-banner" role="status">
          <span><RefreshCw aria-hidden="true" /> 新版本已准备好</span>
          <div>
            <button type="button" className="text-button" onClick={pwa.dismissUpdate}>稍后</button>
            <button type="button" className="secondary-button compact-button" onClick={() => void pwa.update()}>立即更新</button>
          </div>
        </div>
      ) : null}

      <main id="main-content" tabIndex={-1}>
        <div className="workspace-grid">
          <EntryComposer
            onCreate={create}
            onSaved={() => showNotice({ kind: "success", message: "已保存，余额已更新" })}
          />
          <SummaryPanel
            summary={ledger.summary}
            settings={ledger.settings}
            loading={ledger.loading}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>

        {ledger.error ? (
          <section className="load-error" role="alert">
            <h2>无法读取本机账目</h2>
            <p>请确认浏览器允许此网站使用本机存储，然后重新打开页面。</p>
          </section>
        ) : (
          <RecordList
            entries={ledger.entries}
            loading={ledger.loading}
            onEdit={setEditingEntry}
            onDelete={(entry) => void deleteEntry(entry)}
            onStartEntry={focusComposer}
          />
        )}
      </main>

      <footer className="app-footer">
        <span><HardDrive aria-hidden="true" /> 数据仅保存在这台设备</span>
        <span>{pwa.online ? <Wifi aria-hidden="true" /> : <CloudOff aria-hidden="true" />}{pwa.online ? "在线" : "离线"}</span>
      </footer>

      <EditEntryDialog
        entry={editingEntry}
        onClose={() => setEditingEntry(undefined)}
        onSave={saveEdit}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={ledger.settings}
        pwa={pwa}
        onClose={() => setSettingsOpen(false)}
        onDataChanged={() => showNotice({ kind: "success", message: "本机数据已更新" })}
      />

      <UndoToasts items={pendingDeletes} onUndo={(id) => void undoDelete(id)} />
      {notice ? (
        <div className={`notice-toast notice-toast--${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.kind === "success" ? <CheckCircle2 aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
          {notice.message}
        </div>
      ) : null}
      {pwa.offlineReady ? (
        <button type="button" className="offline-ready-toast" onClick={pwa.dismissOfflineReady}>
          <CheckCircle2 aria-hidden="true" /> 已可离线使用
        </button>
      ) : null}
    </div>
  );
}
