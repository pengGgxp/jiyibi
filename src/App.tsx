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
  confirmTreatmentWithAllocations,
  purgeDeletedEntries,
  purgeDeletedEntry,
  softDeleteBalanceAdjustment,
  softDeleteEntry,
  undoDeleteEntry,
  updateEntry,
  updateEntryTreatment,
} from "./data";
import {
  affectsBookBalance,
  calculateRetainedSavingsSummary,
  currentLocalDateKey,
  derivePendingItems,
  evaluateExceptionPrompt,
  filterSnoozedPendingItems,
  payCyclePlanFromSettings,
  type EntryDraft,
  type EntryTreatment,
  type BalanceAdjustment,
  type LedgerEntry,
} from "./domain";
import { EditEntryDialog } from "./components/EditEntryDialog";
import { BalanceAdjustmentDialog, type BalanceEditorMode } from "./components/BalanceAdjustmentDialog";
import { EntryComposer } from "./components/EntryComposer";
import {
  IncomeForecastDialog,
  type IncomeDialogMode,
} from "./components/IncomeForecastDialog";
import { PrimaryNavigation } from "./components/PrimaryNavigation";
import { PendingQueue } from "./components/PendingQueue";
import { RecordList } from "./components/RecordList";
import { SettingsDialog, type SettingsPane } from "./components/SettingsDialog";
import {
  SavingsDialog,
  type SavingsDialogMode,
} from "./components/SavingsDialog";
import { SavingsGoalDialog } from "./components/SavingsGoalDialog";
import { SummaryPanel } from "./components/SummaryPanel";
import { TreatmentConfirmationDialog } from "./components/TreatmentConfirmationDialog";
import { UndoToasts, type PendingDeletion } from "./components/UndoToasts";
import { useLedger } from "./hooks/useLedger";
import { useCloudSync } from "./hooks/useCloudSync";
import { usePwa } from "./hooks/usePwa";
import { usePendingDismissals } from "./hooks/usePendingDismissals";
import { useHashView } from "./hooks/useHashView";
import type { CloudSyncPhase } from "./components/CloudSyncSection";
import type { ExceptionPromptKind } from "./domain/exception-prompt";
import type { RecoveryAllocationSelection } from "./components/TreatmentConfirmationDialog";
import { requestPersistentStorage } from "./lib/storage";

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
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("ledger");
  const [balanceEditorMode, setBalanceEditorMode] = useState<BalanceEditorMode>();
  const [incomeDialogMode, setIncomeDialogMode] = useState<IncomeDialogMode>();
  const [savingsDialogMode, setSavingsDialogMode] = useState<SavingsDialogMode>();
  const [savingsGoalOpen, setSavingsGoalOpen] = useState(false);
  const [savingsPrompt, setSavingsPrompt] = useState<{
    entry: LedgerEntry;
    suggestedAmountMinor: number;
  }>();
  const [pendingDeletes, setPendingDeletes] = useState<PendingDeletion[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [treatmentPrompt, setTreatmentPrompt] = useState<{
    entry: LedgerEntry;
    kind: ExceptionPromptKind;
    detectionRuleVersion?: number;
  }>();
  const [treatmentBusy, setTreatmentBusy] = useState(false);
  const [treatmentError, setTreatmentError] = useState<string>();
  const [adjustmentUndo, setAdjustmentUndo] = useState<BalanceAdjustment>();
  const deletionTimers = useRef(new Map<string, number>());
  const noticeTimer = useRef<number | undefined>(undefined);
  const adjustmentUndoTimer = useRef<number | undefined>(undefined);
  const persistenceAttempted = useRef(false);
  const previousView = useRef(view);
  const incomeForecast = ledger.settings?.incomeForecast;
  const todayDateKey = currentLocalDateKey();
  const { dismissals, snooze: snoozePending } = usePendingDismissals(todayDateKey);
  const activePayCycle = ledger.settings
    ? payCyclePlanFromSettings(ledger.settings)
    : undefined;
  const retainedSavings = calculateRetainedSavingsSummary(ledger.savingsEvents);
  const retainedMinor = ledger.analysis?.currentCycle.retainedBalanceMinor
    ?? retainedSavings.totalRetainedMinor;
  const unretainedMinor = BigInt(ledger.summary?.balanceMinor ?? 0) - retainedMinor;
  const openingSavingsMinor = ledger.savingsEvents.find(
    (event) => event.kind === "opening",
  )?.amountMinor ?? 0;
  const hasLedgerFacts = Boolean(ledger.settings?.initialBalanceLockedAt)
    || ledger.entries.length > 0
    || ledger.savingsEvents.length > 0
    || ledger.balanceAdjustments.length > 0;
  const pendingItems = filterSnoozedPendingItems(derivePendingItems({
    entries: ledger.entries,
    allocations: ledger.recoveryAllocations,
    incomeForecast,
    retainedMinor,
    balanceMinor: ledger.summary?.balanceMinor ?? 0,
    todayDateKey,
    analysis: ledger.analysis,
  }), dismissals, todayDateKey);
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
      window.clearTimeout(adjustmentUndoTimer.current);
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
    if (!hasLedgerFacts || persistenceAttempted.current) return;
    persistenceAttempted.current = true;
    const key = "jiyibi:persistent-storage-attempted";
    try {
      const storage = globalThis.localStorage;
      if (typeof storage?.getItem === "function" && storage.getItem(key)) return;
      if (typeof storage?.setItem === "function") storage.setItem(key, new Date().toISOString());
    } catch {
      // Persistence is an enhancement; IndexedDB remains the source of truth.
    }
    void requestPersistentStorage();
  }, [hasLedgerFacts]);

  const maybePromptTreatment = async (entry: LedgerEntry): Promise<boolean> => {
    const decision = evaluateExceptionPrompt(entry, ledger.entries, ledger.analysis);
    if (!decision.shouldPrompt) return false;
    setTreatmentError(undefined);
    let pendingEntry = entry;
    try {
      pendingEntry = await updateEntryTreatment(
        entry.id,
        entry.treatment,
        {
          confirmationStatus: "pending",
          detectionRuleVersion: decision.detectionRuleVersion,
        },
      );
      cloud.requestSync();
    } catch {
      // The confirmation layer still lets the user retry the atomic final write.
    }
    setTreatmentPrompt({
      entry: pendingEntry,
      kind: decision.kind,
      detectionRuleVersion: decision.detectionRuleVersion,
    });
    return true;
  };

  const savingsUsePromptFor = (
    entry: LedgerEntry,
    treatment: EntryTreatment = entry.treatment,
    previousEntry?: LedgerEntry,
  ) => {
    if (
      entry.amountMinor >= 0
      || retainedMinor <= 0n
      || !affectsBookBalance({ ...entry, treatment })
    ) return undefined;

    let balanceAfterEntry = BigInt(ledger.summary?.balanceMinor ?? 0);
    if (previousEntry) {
      if (affectsBookBalance(previousEntry)) {
        balanceAfterEntry -= BigInt(previousEntry.amountMinor);
      }
      balanceAfterEntry += BigInt(entry.amountMinor);
    } else if (!ledger.entries.some((item) => item.id === entry.id)) {
      balanceAfterEntry += BigInt(entry.amountMinor);
    }
    const penetrationMinor = retainedMinor - balanceAfterEntry;
    if (penetrationMinor <= 0n) return undefined;
    const expenseMinor = -BigInt(entry.amountMinor);
    const suggestedAmountMinor = [penetrationMinor, expenseMinor, retainedMinor]
      .reduce((smallest, value) => value < smallest ? value : smallest);
    if (suggestedAmountMinor <= 0n || suggestedAmountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    return { entry, suggestedAmountMinor: Number(suggestedAmountMinor) };
  };

  const create = async (draft: EntryDraft) => {
    try {
      const entry = await createEntry(draft);
      cloud.requestSync();
      return entry;
    } catch (reason) {
      throw mutationError(reason, "没有保存成功，请检查本机存储后重试");
    }
  };

  const handleCreated = async (entry?: LedgerEntry) => {
    const nextSavingsPrompt = entry ? savingsUsePromptFor(entry) : undefined;
    if (entry && await maybePromptTreatment(entry)) {
      setSavingsPrompt(undefined);
      showNotice({
        kind: "success",
        message: cloud.linked ? "已保存到本机，正在同步" : "已保存，余额已更新",
      });
      return;
    }
    if (nextSavingsPrompt) {
      setSavingsPrompt(nextSavingsPrompt);
      setSavingsDialogMode("release");
    }
    showNotice({
      kind: "success",
      message: cloud.linked ? "已保存到本机，正在同步" : "已保存，余额已更新",
    });
  };

  const saveEdit = async (id: string, draft: EntryDraft) => {
    try {
      const previousEntry = ledger.entries.find((entry) => entry.id === id);
      const updated = await updateEntry(id, draft);
      const nextSavingsPrompt = savingsUsePromptFor(
        updated,
        updated.treatment,
        previousEntry,
      );
      cloud.requestSync();
      showNotice({ kind: "success", message: "记录已更新，余额已重算" });
      if (await maybePromptTreatment(updated)) {
        setSavingsPrompt(undefined);
      } else if (nextSavingsPrompt) {
        setSavingsPrompt(nextSavingsPrompt);
        setSavingsDialogMode("release");
      }
    } catch (reason) {
      throw mutationError(reason, "修改没有保存，请重试");
    }
  };

  const confirmTreatment = async (
    treatment: EntryTreatment,
    allocations: readonly RecoveryAllocationSelection[] = [],
  ) => {
    if (!treatmentPrompt) return;
    setTreatmentBusy(true);
    setTreatmentError(undefined);
    try {
      await confirmTreatmentWithAllocations(
        treatmentPrompt.entry.id,
        treatment,
        allocations,
        {
          detectionRuleVersion: treatmentPrompt.detectionRuleVersion,
          markPrompted: true,
        },
      );
      cloud.requestSync();
      setTreatmentPrompt(undefined);
      if (savingsPrompt?.entry.id === treatmentPrompt.entry.id) setSavingsPrompt(undefined);
      showNotice({ kind: "success", message: "处理方式已更新，分析已重算" });
    } catch (reason) {
      setTreatmentError(reason instanceof Error ? reason.message : "处理方式没有保存，请重试");
    } finally {
      setTreatmentBusy(false);
    }
  };

  const deferTreatment = () => {
    if (!treatmentPrompt) return;
    setTreatmentError(undefined);
    snoozePending(`treatment:${treatmentPrompt.entry.id}`);
    setTreatmentPrompt(undefined);
    if (savingsPrompt?.entry.id === treatmentPrompt.entry.id) setSavingsPrompt(undefined);
  };

  const openPendingConfirmation = (entry: LedgerEntry) => {
    setTreatmentError(undefined);
    setTreatmentPrompt({
      entry,
      kind: entry.amountMinor < 0 ? "expense" : "income",
      detectionRuleVersion: entry.detectionRuleVersion,
    });
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

  const openSettings = (pane: SettingsPane = "ledger") => {
    setSettingsPane(pane);
    setSettingsOpen(true);
  };

  const openPendingItem = (item: (typeof pendingItems)[number]) => {
    if (item.kind === "income_due") {
      openIncomeDialog("actual");
      return;
    }
    if (item.kind === "entry_treatment") {
      openPendingConfirmation(item.entry);
      return;
    }
    if (item.kind === "savings_penetration") {
      setSavingsPrompt(item.sourceEntry ? {
        entry: item.sourceEntry,
        suggestedAmountMinor: item.suggestedAmountMinor,
      } : undefined);
      setSavingsDialogMode("release");
      return;
    }
    setTreatmentError(undefined);
    setTreatmentPrompt({ entry: item.refund, kind: "income" });
  };

  const offerAdjustmentUndo = (adjustment?: BalanceAdjustment) => {
    if (!adjustment) return;
    window.clearTimeout(adjustmentUndoTimer.current);
    setAdjustmentUndo(adjustment);
    adjustmentUndoTimer.current = window.setTimeout(() => setAdjustmentUndo(undefined), 8_000);
  };

  const undoAdjustment = async () => {
    if (!adjustmentUndo) return;
    window.clearTimeout(adjustmentUndoTimer.current);
    try {
      await softDeleteBalanceAdjustment(adjustmentUndo.id);
      cloud.requestSync();
      setAdjustmentUndo(undefined);
      showNotice({ kind: "success", message: "余额调整已撤销" });
    } catch (reason) {
      showNotice({ kind: "error", message: reason instanceof Error ? reason.message : "撤销失败" });
    }
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
            onClick={() => openSettings("data")}
            aria-label={`查看云同步详情：${cloud.headerLabel}`}
            title={`${cloud.headerLabel}，查看同步详情`}
          >
            <CloudStatusIcon phase={cloud.phase} />
            <span>{cloud.headerLabel}</span>
          </button>
          <button type="button" className="icon-button header-settings" onClick={() => openSettings("ledger")} aria-label="打开设置" title="设置">
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
            <PendingQueue
              items={pendingItems}
              onOpen={openPendingItem}
              onSnooze={(item) => snoozePending(item.id)}
            />
            <div className={`workspace-grid${!hasLedgerFacts ? " is-first-use" : ""}`}>
              <EntryComposer
                onCreate={create}
                onSaved={handleCreated}
              />
              <SummaryPanel
                summary={ledger.summary}
                settings={ledger.settings}
                payCycle={activePayCycle}
                analysis={ledger.analysis}
                retainedSavings={retainedSavings}
                analysisError={ledger.analysisError}
                loading={ledger.loading}
                hasLedgerFacts={hasLedgerFacts}
                onOpenSettings={() => openSettings("ledger")}
                onOpenBalance={() => setBalanceEditorMode(ledger.settings?.initialBalanceLockedAt ? "reconciliation" : "initial")}
                onOpenIncomeForecast={() => openIncomeDialog("forecast")}
                onOpenSavingsGoal={() => setSavingsGoalOpen(true)}
                onOpenAnalysis={() => navigate("analysis")}
                onReserveSavings={() => {
                  setSavingsPrompt(undefined);
                  setSavingsDialogMode("reserve");
                }}
                onReleaseSavings={() => {
                  setSavingsPrompt(undefined);
                  setSavingsDialogMode("release");
                }}
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
                balanceAdjustments={ledger.balanceAdjustments}
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
              savingsEvents={ledger.savingsEvents}
              summary={ledger.summary}
              settings={ledger.settings}
              payCycle={activePayCycle}
              entryCount={ledger.entries.length}
              loading={ledger.loading}
              error={ledger.analysisError?.message ?? ledger.error?.message}
              onOpenSettings={() => openSettings("ledger")}
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
        onTreatmentChange={async (id, treatment) => {
          await confirmTreatmentWithAllocations(id, treatment, []);
          cloud.requestSync();
          showNotice({ kind: "success", message: "处理方式已更新，分析已重算" });
        }}
      />
      <TreatmentConfirmationDialog
        entry={treatmentPrompt?.entry}
        kind={treatmentPrompt?.kind ?? "expense"}
        entries={ledger.entries}
        allocations={ledger.recoveryAllocations}
        busy={treatmentBusy}
        error={treatmentError}
        onConfirm={confirmTreatment}
        onDefer={deferTreatment}
        onClose={deferTreatment}
      />
      <SettingsDialog
        open={settingsOpen}
        initialPane={settingsPane}
        settings={ledger.settings}
        openingSavingsMinor={openingSavingsMinor}
        pwa={pwa}
        cloudSync={cloud.settingsProps}
        onClose={() => setSettingsOpen(false)}
        onOpenIncomeForecast={() => openIncomeDialog("forecast")}
        onOpenSavingsGoal={() => {
          setSettingsOpen(false);
          setSavingsGoalOpen(true);
        }}
        onOpenBalance={(mode) => {
          setSettingsOpen(false);
          setBalanceEditorMode(mode);
        }}
        onDataChanged={() => {
          cloud.requestSync();
          showNotice({ kind: "success", message: cloud.linked ? "本机数据已更新，正在同步" : "本机数据已更新" });
        }}
      />
      <BalanceAdjustmentDialog
        open={balanceEditorMode !== undefined}
        mode={balanceEditorMode}
        currentBalanceMinor={ledger.summary?.balanceMinor ?? 0}
        initialBalanceMinor={ledger.settings?.initialBalanceMinor ?? 0}
        locked={Boolean(ledger.settings?.initialBalanceLockedAt)}
        adjustments={ledger.balanceAdjustments}
        onClose={() => setBalanceEditorMode(undefined)}
        onSaved={(adjustment) => {
          setBalanceEditorMode(undefined);
          cloud.requestSync();
          offerAdjustmentUndo(adjustment);
          showNotice({ kind: "success", message: adjustment ? "余额已更新，可在 8 秒内撤销" : "余额已更新" });
        }}
      />
      <SavingsDialog
        open={savingsDialogMode !== undefined}
        mode={savingsDialogMode ?? "reserve"}
        retainedMinor={retainedMinor}
        availableMinor={unretainedMinor > 0n ? unretainedMinor : 0n}
        linkedExpense={savingsPrompt?.entry}
        suggestedAmountMinor={savingsPrompt?.suggestedAmountMinor}
        onClose={() => {
          setSavingsDialogMode(undefined);
          setSavingsPrompt(undefined);
        }}
        onSaved={(message) => {
          cloud.requestSync();
          showNotice({ kind: "success", message });
        }}
      />
      <SavingsGoalDialog
        open={savingsGoalOpen}
        settings={ledger.settings}
        onClose={() => setSavingsGoalOpen(false)}
        onSaved={(message) => {
          cloud.requestSync();
          showNotice({ kind: "success", message });
        }}
      />
      <IncomeForecastDialog
        open={incomeDialogMode !== undefined}
        mode={incomeDialogMode ?? "forecast"}
        settings={ledger.settings}
        onClose={() => setIncomeDialogMode(undefined)}
        onModeChange={setIncomeDialogMode}
        onSaved={(message) => {
          cloud.requestSync();
          showNotice({
            kind: "success",
            message: cloud.linked ? `${message}，正在同步` : message,
          });
        }}
      />

      <UndoToasts items={pendingDeletes} onUndo={(id) => void undoDelete(id)}>
        {adjustmentUndo ? (
          <div className="adjustment-undo-toast">
            <span role="status">{adjustmentUndo.kind === "reconciliation" ? "余额已校准" : "起点已更正"}</span>
            <button type="button" className="text-button" onClick={() => void undoAdjustment()}>撤销</button>
          </div>
        ) : null}
      </UndoToasts>
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
