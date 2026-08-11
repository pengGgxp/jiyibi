import {
  CircleAlert,
  CheckCircle2,
  Cloud,
  CloudAlert,
  CloudOff,
  HardDrive,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  Settings,
  Wifi,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  createEntry,
  purgeDeletedEntries,
  purgeDeletedEntry,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
} from "./data";
import {
  currentLocalDateKey,
  payCyclePlanFromSettings,
  type EntryDraft,
  type LedgerEntry,
} from "./domain";
import { EditEntryDialog } from "./components/EditEntryDialog";
import { EntryComposer } from "./components/EntryComposer";
import {
  IncomeForecastDialog,
  type IncomeDialogMode,
} from "./components/IncomeForecastDialog";
import { PrimaryNavigation } from "./components/PrimaryNavigation";
import { RecordList } from "./components/RecordList";
import { SettingsDialog } from "./components/SettingsDialog";
import { SummaryPanel } from "./components/SummaryPanel";
import { UndoToasts, type PendingDeletion } from "./components/UndoToasts";
import { useLedger } from "./hooks/useLedger";
import { useCloudSync } from "./hooks/useCloudSync";
import { usePwa } from "./hooks/usePwa";
import { useHashView } from "./hooks/useHashView";
import type { CloudSyncPhase } from "./components/CloudSyncSection";

const AnalysisView = lazy(async () => {
  const module = await import("./components/AnalysisView");
  return { default: module.AnalysisView };
});

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

function CloudStatusIcon({ phase }: { phase: CloudSyncPhase }) {
  if (phase === "unavailable") return <HardDrive aria-hidden="true" />;
  if (phase === "offline") return <CloudOff aria-hidden="true" />;
  if (phase === "checking" || phase === "linking" || phase === "syncing") {
    return <LoaderCircle className="spin" aria-hidden="true" />;
  }
  if (phase === "error" || phase === "conflict" || phase === "account-mismatch") {
    return <CloudAlert aria-hidden="true" />;
  }
  return <Cloud aria-hidden="true" />;
}

export default function App() {
  const ledger = useLedger();
  const pwa = usePwa();
  const cloud = useCloudSync();
  const [view, navigate] = useHashView();
  const [editingEntry, setEditingEntry] = useState<LedgerEntry>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [incomeDialogMode, setIncomeDialogMode] = useState<IncomeDialogMode>();
  const [incomeReminderDismissed, setIncomeReminderDismissed] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState<PendingDeletion[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const deletionTimers = useRef(new Map<string, number>());
  const noticeTimer = useRef<number | undefined>(undefined);
  const previousView = useRef(view);
  const incomeForecast = ledger.settings?.incomeForecast;
  const todayDateKey = currentLocalDateKey();
  const dueIncomeForecast = incomeForecast && incomeForecast.targetPaydayDateKey <= todayDateKey
    ? incomeForecast
    : undefined;

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

  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("main-content")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  useEffect(() => {
    setIncomeReminderDismissed(false);
  }, [incomeForecast?.id]);

  const create = async (draft: EntryDraft) => {
    try {
      await createEntry(draft);
      cloud.requestSync();
    } catch (reason) {
      throw mutationError(reason, "没有保存成功，请检查本机存储后重试");
    }
  };

  const saveEdit = async (id: string, draft: EntryDraft) => {
    try {
      await updateEntry(id, draft);
      cloud.requestSync();
      showNotice({ kind: "success", message: "记录已更新，余额已重算" });
    } catch (reason) {
      throw mutationError(reason, "修改没有保存，请重试");
    }
  };

  const deleteEntry = async (entry: LedgerEntry) => {
    if (deletionTimers.current.has(entry.id)) return;
    try {
      await softDeleteEntry(entry.id);
      cloud.requestSync();
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
        }).finally(cloud.requestSync);
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
      cloud.requestSync();
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

  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById("main-content")?.focus();
  };

  const openIncomeDialog = (mode: IncomeDialogMode) => {
    setSettingsOpen(false);
    setIncomeDialogMode(mode);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={skipToMain}>跳到主要内容</a>
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><ReceiptText aria-hidden="true" /></span>
          <div>
            <h1>记一笔</h1>
            <p>收支随手记</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`local-status sync-status-button ${cloud.phase === "offline" ? "is-offline" : ""} ${["error", "conflict", "account-mismatch"].includes(cloud.phase) ? "has-error" : ""}`}
            onClick={() => setSettingsOpen(true)}
            aria-label={`查看云同步详情：${cloud.headerLabel}`}
            title={`${cloud.headerLabel}，查看同步详情`}
          >
            <CloudStatusIcon phase={cloud.phase} />
            <span>{cloud.headerLabel}</span>
          </button>
          <button type="button" className="icon-button header-settings" onClick={() => setSettingsOpen(true)} aria-label="打开设置" title="设置">
            <Settings aria-hidden="true" />
          </button>
        </div>
      </header>

      <PrimaryNavigation view={view} />

      {!pwa.online ? (
        <div className="network-banner" role="status">
          <CloudOff aria-hidden="true" /> 当前离线，仍可查看和记录本机账目{cloud.linked ? "；联网后会继续同步。" : "。"}
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
        {view === "ledger" ? (
          <>
            {dueIncomeForecast && !incomeReminderDismissed ? (
              <section className="income-reminder" aria-labelledby="income-reminder-title">
                <div>
                  <CircleAlert aria-hidden="true" />
                  <span>
                    <strong id="income-reminder-title">
                      {dueIncomeForecast.targetPaydayDateKey === todayDateKey
                        ? "今天是发薪日，记一下实际收入"
                        : "这次发薪日已到，记一下实际收入"}
                    </strong>
                    <small>确认后才会计入余额，并结束本次提醒。</small>
                  </span>
                </div>
                <div className="income-reminder-actions">
                  <button type="button" className="text-button" onClick={() => setIncomeReminderDismissed(true)}>稍后</button>
                  <button type="button" className="primary-button" onClick={() => openIncomeDialog("actual")}>填写实际收入</button>
                </div>
              </section>
            ) : null}
            <div className="workspace-grid">
              <SummaryPanel
                summary={ledger.summary}
                settings={ledger.settings}
                payCycle={ledger.settings ? payCyclePlanFromSettings(ledger.settings) : undefined}
                analysis={ledger.analysis}
                analysisError={ledger.analysisError}
                loading={ledger.loading}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenIncomeForecast={() => openIncomeDialog("forecast")}
                onOpenAnalysis={() => navigate("analysis")}
              />
              <EntryComposer
                onCreate={create}
                onSaved={() => showNotice({
                  kind: "success",
                  message: cloud.linked ? "已保存到本机，正在同步" : "已保存，余额已更新",
                })}
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
                loadAttachment={cloud.loadAttachment}
                onEdit={setEditingEntry}
                onDelete={(entry) => void deleteEntry(entry)}
                onStartEntry={focusComposer}
              />
            )}
          </>
        ) : (
          <Suspense fallback={<div className="analysis-route-loading" role="status">正在打开分析…</div>}>
            <AnalysisView
              analysis={ledger.analysis}
              summary={ledger.summary}
              settings={ledger.settings}
              payCycle={ledger.settings ? payCyclePlanFromSettings(ledger.settings) : undefined}
              entryCount={ledger.entries.length}
              loading={ledger.loading}
              error={ledger.analysisError?.message ?? ledger.error?.message}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenIncomeForecast={() => openIncomeDialog("forecast")}
              onOpenLedger={() => navigate("ledger")}
            />
          </Suspense>
        )}
      </main>

      <footer className="app-footer">
        <span><HardDrive aria-hidden="true" /> {cloud.linked ? "本机保存，登录后同步" : "数据保存在这台设备"}</span>
        <span>{pwa.online ? <Wifi aria-hidden="true" /> : <CloudOff aria-hidden="true" />}{pwa.online ? "在线" : "离线"}</span>
      </footer>

      <EditEntryDialog
        entry={editingEntry}
        loadAttachment={cloud.loadAttachment}
        onClose={() => setEditingEntry(undefined)}
        onSave={saveEdit}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={ledger.settings}
        pwa={pwa}
        cloudSync={cloud.settingsProps}
        onClose={() => setSettingsOpen(false)}
        onOpenIncomeForecast={() => openIncomeDialog("forecast")}
        onDataChanged={() => {
          cloud.requestSync();
          showNotice({ kind: "success", message: cloud.linked ? "本机数据已更新，正在同步" : "本机数据已更新" });
        }}
      />
      <IncomeForecastDialog
        open={incomeDialogMode !== undefined}
        mode={incomeDialogMode ?? "forecast"}
        settings={ledger.settings}
        onClose={() => setIncomeDialogMode(undefined)}
        onSaved={(message) => {
          cloud.requestSync();
          showNotice({
            kind: "success",
            message: cloud.linked ? `${message}，正在同步` : message,
          });
        }}
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
