import {
  ArrowDownLeft,
  ArrowUpRight,
  Image as ImageIcon,
  Pencil,
  ReceiptText,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAttachment } from "../data";
import {
  activeRecoveryAmount,
  currentLocalDateTimeInput,
  entryToLocalDateTimeInput,
  formatCny,
  unrecoveredExpenseMinor,
  type Attachment,
  type BalanceAdjustment,
  type EntryTreatment,
  type LedgerEntry,
  type RecoveryAllocation,
} from "../domain";
import { useObjectUrl } from "../hooks/useObjectUrl";
import { Modal } from "./Modal";

export type ReimbursementFinalTreatment = Extract<
  EntryTreatment,
  "ordinary_expense" | "periodic_expense" | "one_time_expense"
>;

interface RecordListProps {
  entries: LedgerEntry[];
  balanceAdjustments?: BalanceAdjustment[];
  recoveryAllocations?: readonly RecoveryAllocation[];
  loading: boolean;
  loadAttachment?(attachmentId: string): Promise<Attachment | undefined>;
  onEdit(entry: LedgerEntry): void;
  onDelete(entry: LedgerEntry): void;
  onCloseReimbursement?(
    entryId: string,
    treatment: ReimbursementFinalTreatment,
  ): void | Promise<void>;
  onStartEntry(): void;
}

function dateLabel(dateKey: string): string {
  const today = currentLocalDateTimeInput().slice(0, 10);
  if (dateKey === today) return "今天";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === currentLocalDateTimeInput(yesterday).slice(0, 10)) return "昨天";
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
    ...(year !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(new Date(year, month - 1, day));
}

function entryTime(entry: LedgerEntry): string {
  try {
    return entryToLocalDateTimeInput(entry.occurredAt, entry.timezoneOffsetMinutes)
      .slice(11, 16);
  } catch {
    return "时间未知";
  }
}

function signedAmount(entry: LedgerEntry): string {
  const absolute = formatCny(Math.abs(entry.amountMinor));
  return `${entry.amountMinor < 0 ? "−" : "+"}${absolute}`;
}

function treatmentBadges(
  entry: LedgerEntry,
  allocations: readonly RecoveryAllocation[],
): string[] {
  if (entry.confirmationStatus === "pending") return ["待确认"];
  const badges: string[] = [];
  switch (entry.treatment) {
    case "periodic_expense":
      badges.push("周期账单");
      break;
    case "one_time_expense":
      badges.push("仅这一次");
      break;
    case "refund_reimbursement":
      badges.push("退款报销");
      break;
    case "account_transfer":
      badges.push("账户转账");
      break;
    default:
      break;
  }

  if (entry.amountMinor >= 0) return badges;
  const recoveredMinor = activeRecoveryAmount(
    allocations,
    (allocation) => allocation.expenseEntryId === entry.id,
  );
  const remainingMinor = unrecoveredExpenseMinor(entry, allocations);
  if (entry.treatment === "reimbursable_expense") {
    return remainingMinor === 0
      ? ["已报销"]
      : [`待报 ${formatCny(remainingMinor)}`];
  }
  if (recoveredMinor > 0) {
    badges.push(remainingMinor === 0 ? "已报销" : `自付 ${formatCny(remainingMinor)}`);
  }
  return badges;
}

const REIMBURSEMENT_FINAL_OPTIONS: ReadonlyArray<{
  value: ReimbursementFinalTreatment;
  label: string;
  detail: string;
}> = [
  { value: "ordinary_expense", label: "按日常算", detail: "剩余金额会进入日常花法。" },
  { value: "periodic_expense", label: "周期账单", detail: "计入个人支出，但不外推。" },
  { value: "one_time_expense", label: "仅这一次", detail: "计入个人支出，但不外推。" },
];

function CloseReimbursementDialog({
  entry,
  allocations,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  entry?: LedgerEntry;
  allocations: readonly RecoveryAllocation[];
  busy: boolean;
  error?: string;
  onClose(): void;
  onConfirm(treatment: ReimbursementFinalTreatment): void;
}) {
  const [selected, setSelected] = useState<ReimbursementFinalTreatment>();

  useEffect(() => {
    setSelected(undefined);
  }, [entry?.id]);

  if (!entry) return null;
  const remainingMinor = unrecoveredExpenseMinor(entry, allocations);
  return (
    <Modal
      open
      title="结束报销"
      description="未报部分将转为你的实际支出。"
      onClose={onClose}
    >
      <div className="reimbursement-close">
        <p className="reimbursement-close-amount">未报 {formatCny(remainingMinor)}</p>
        <fieldset className="treatment-confirm-options">
          <legend>剩余金额怎么算</legend>
          {REIMBURSEMENT_FINAL_OPTIONS.map((option, index) => (
            <label
              key={option.value}
              className={`treatment-confirm-option${selected === option.value ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="reimbursement-final-treatment"
                value={option.value}
                checked={selected === option.value}
                data-autofocus={index === 0 ? true : undefined}
                disabled={busy}
                onChange={() => setSelected(option.value)}
              />
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
            </label>
          ))}
        </fieldset>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !selected}
            onClick={() => selected && onConfirm(selected)}
          >
            {busy ? "保存中…" : "确认结束"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AttachmentThumbnail({
  entry,
  loadAttachment,
}: {
  entry: LedgerEntry;
  loadAttachment(attachmentId: string): Promise<Attachment | undefined>;
}) {
  const [attachment, setAttachment] = useState<Attachment>();
  const [loadAttachmentId, setLoadAttachmentId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const placeholderRef = useRef<HTMLSpanElement>(null);
  const url = useObjectUrl(attachment?.blob);

  useEffect(() => {
    setAttachment(undefined);
    setFailed(false);
    setLoadAttachmentId(undefined);
    if (!entry.attachmentId) return undefined;

    const target = placeholderRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setLoadAttachmentId(entry.attachmentId);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          setLoadAttachmentId(entry.attachmentId);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [entry.attachmentId]);

  useEffect(() => {
    let active = true;
    if (!entry.attachmentId || loadAttachmentId !== entry.attachmentId) return undefined;
    void loadAttachment(entry.attachmentId)
      .then((result) => {
        if (active) {
          setAttachment(result);
          setFailed(!result);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [entry.attachmentId, loadAttachmentId, loadAttachment]);

  if (!entry.attachmentId) {
    const isExpense = entry.amountMinor < 0;
    return (
      <span className={`record-thumbnail record-kind-icon ${isExpense ? "expense" : "income"}`} aria-hidden="true">
        {isExpense ? <ArrowUpRight /> : <ArrowDownLeft />}
      </span>
    );
  }
  if (url) {
    return (
      <img
        className="record-thumbnail"
        src={url}
        alt={entry.note ? `${entry.note}的账目截图` : "账目截图"}
        loading="lazy"
      />
    );
  }
  return (
    <span ref={placeholderRef} className={`record-thumbnail thumbnail-placeholder${failed ? " is-failed" : ""}`} aria-label={failed ? "截图读取失败" : "正在读取截图"}>
      <ImageIcon aria-hidden="true" />
    </span>
  );
}

export function RecordList({
  entries,
  balanceAdjustments = [],
  recoveryAllocations = [],
  loading,
  loadAttachment = getAttachment,
  onEdit,
  onDelete,
  onCloseReimbursement,
  onStartEntry,
}: RecordListProps) {
  const [closingReimbursement, setClosingReimbursement] = useState<LedgerEntry>();
  const [closingBusy, setClosingBusy] = useState(false);
  const [closingError, setClosingError] = useState<string>();
  const closingRestoreFocusIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const entryId = closingRestoreFocusIdRef.current;
    if (!entryId || closingReimbursement) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(`edit-entry-${entryId}`);
      if (!target) return;
      target.focus();
      closingRestoreFocusIdRef.current = undefined;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closingReimbursement, entries]);

  const groups = useMemo(() => {
    const next = new Map<string, LedgerEntry[]>();
    for (const entry of entries) {
      const group = next.get(entry.localDateKey) ?? [];
      group.push(entry);
      next.set(entry.localDateKey, group);
    }
    return Array.from(next.entries());
  }, [entries]);

  return (
    <section className="records-section" aria-labelledby="records-title" aria-busy={loading}>
      <div className="records-heading">
        <div>
          <p className="eyebrow">本机账本</p>
          <h2 id="records-title" tabIndex={-1}>最近记录</h2>
        </div>
        {!loading ? <p>{entries.length} 笔</p> : null}
      </div>

      {loading ? (
        <div className="record-loading" aria-label="正在读取账目">
          <span /><span /><span />
        </div>
      ) : groups.length === 0 && balanceAdjustments.length === 0 ? (
        <div className="empty-records">
          <ReceiptText aria-hidden="true" />
          <div>
            <h3>账本还是空的</h3>
            <p>第一笔保存后，会按日期出现在这里。</p>
          </div>
          <button type="button" className="secondary-button" onClick={onStartEntry}>开始记一笔</button>
        </div>
      ) : (
        <div className="record-groups">
          {balanceAdjustments.length > 0 ? (
            <section className="balance-adjustment-history" aria-labelledby="balance-adjustment-history-title">
              <div className="date-heading">
                <h3 id="balance-adjustment-history-title">余额变动</h3>
                <span>{balanceAdjustments.length} 条</span>
              </div>
              <ul className="record-list">
                {balanceAdjustments.map((adjustment) => (
                  <li key={adjustment.id}>
                    <article className={`record-row balance-adjustment-row${adjustment.deletedAt ? " is-reverted" : ""}`}>
                      <span className="record-thumbnail balance-adjustment-icon" aria-hidden="true"><ReceiptText /></span>
                      <div className="record-copy">
                        <p>{adjustment.kind === "reconciliation" ? "余额校准" : "起点更正"}</p>
                        <span>{adjustment.localDateKey} · {adjustment.note || "无说明"}{adjustment.deletedAt ? " · 已撤销" : ""}</span>
                      </div>
                      <strong className="balance-adjustment-amount">
                        {adjustment.amountMinor > 0 ? "+" : "−"}{formatCny(Math.abs(adjustment.amountMinor))}
                      </strong>
                    </article>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {groups.map(([dateKey, dateEntries]) => (
            <section className="record-group" key={dateKey} aria-labelledby={`date-${dateKey}`}>
              <div className="date-heading">
                <h3 id={`date-${dateKey}`}>{dateLabel(dateKey)}</h3>
                <span>{dateEntries.length} 笔</span>
              </div>
              <ul className="record-list">
                {dateEntries.map((entry) => {
                  const isExpense = entry.amountMinor < 0;
                  const badges = treatmentBadges(entry, recoveryAllocations);
                  const canCloseReimbursement = entry.treatment === "reimbursable_expense"
                    && unrecoveredExpenseMinor(entry, recoveryAllocations) > 0
                    && onCloseReimbursement !== undefined;
                  return (
                    <li key={entry.id}>
                      <article className="record-row">
                        <AttachmentThumbnail entry={entry} loadAttachment={loadAttachment} />
                        <div className="record-copy">
                          <p>{entry.note || "截图记录"}</p>
                          <span>
                            {entryTime(entry)} · {isExpense ? "支出" : "收入"}
                            {badges.length ? ` · ${badges.join(" · ")}` : ""}
                          </span>
                          {canCloseReimbursement ? (
                            <button
                              type="button"
                              className="text-button record-reimbursement-action"
                              onClick={() => {
                                setClosingError(undefined);
                                setClosingReimbursement(entry);
                              }}
                            >
                              结束报销
                            </button>
                          ) : null}
                        </div>
                        <strong className={isExpense ? "expense-amount" : "income-amount"}>
                          <span className="sr-only">{isExpense ? "支出" : "收入"}</span>
                          {signedAmount(entry)}
                        </strong>
                        <div className="record-actions">
                          <button
                            id={`edit-entry-${entry.id}`}
                            type="button"
                            className="icon-button"
                            onClick={() => onEdit(entry)}
                            aria-label={`编辑${entry.note || "这笔记录"}`}
                            title="编辑"
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button type="button" className="icon-button destructive" onClick={() => onDelete(entry)} aria-label={`删除${entry.note || "这笔记录"}`} title="删除">
                            <Trash2 aria-hidden="true" />
                          </button>
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      <CloseReimbursementDialog
        entry={closingReimbursement}
        allocations={recoveryAllocations}
        busy={closingBusy}
        error={closingError}
        onClose={() => {
          if (closingBusy) return;
          setClosingReimbursement(undefined);
          setClosingError(undefined);
        }}
        onConfirm={(treatment) => {
          if (!closingReimbursement || !onCloseReimbursement) return;
          const entryId = closingReimbursement.id;
          setClosingBusy(true);
          setClosingError(undefined);
          void Promise.resolve(onCloseReimbursement(entryId, treatment))
            .then(() => {
              closingRestoreFocusIdRef.current = entryId;
              setClosingReimbursement(undefined);
            })
            .catch((reason) => {
              setClosingError(reason instanceof Error ? reason.message : "保存失败，请重试");
            })
            .finally(() => setClosingBusy(false));
        }}
      />
    </section>
  );
}
