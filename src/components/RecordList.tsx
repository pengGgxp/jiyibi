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
  currentLocalDateTimeInput,
  entryToLocalDateTimeInput,
  formatCny,
  type Attachment,
  type LedgerEntry,
} from "../domain";
import { useObjectUrl } from "../hooks/useObjectUrl";

interface RecordListProps {
  entries: LedgerEntry[];
  loading: boolean;
  loadAttachment?(attachmentId: string): Promise<Attachment | undefined>;
  onEdit(entry: LedgerEntry): void;
  onDelete(entry: LedgerEntry): void;
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

function treatmentBadge(entry: LedgerEntry): string | undefined {
  if (entry.confirmationStatus === "pending") return "待确认";
  switch (entry.treatment) {
    case "one_time_expense":
      return "一次性";
    case "reimbursable_expense":
      return "报销";
    case "refund_reimbursement":
      return "退款";
    case "account_transfer":
      return "账户转账";
    default:
      return undefined;
  }
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
  loading,
  loadAttachment = getAttachment,
  onEdit,
  onDelete,
  onStartEntry,
}: RecordListProps) {
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
      ) : groups.length === 0 ? (
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
          {groups.map(([dateKey, dateEntries]) => (
            <section className="record-group" key={dateKey} aria-labelledby={`date-${dateKey}`}>
              <div className="date-heading">
                <h3 id={`date-${dateKey}`}>{dateLabel(dateKey)}</h3>
                <span>{dateEntries.length} 笔</span>
              </div>
              <ul className="record-list">
                {dateEntries.map((entry) => {
                  const isExpense = entry.amountMinor < 0;
                  const badge = treatmentBadge(entry);
                  return (
                    <li key={entry.id}>
                      <article className="record-row">
                        <AttachmentThumbnail entry={entry} loadAttachment={loadAttachment} />
                        <div className="record-copy">
                          <p>{entry.note || "截图记录"}</p>
                          <span>
                            {entryTime(entry)} · {isExpense ? "支出" : "收入"}
                            {badge ? ` · ${badge}` : ""}
                          </span>
                        </div>
                        <strong className={isExpense ? "expense-amount" : "income-amount"}>
                          <span className="sr-only">{isExpense ? "支出" : "收入"}</span>
                          {signedAmount(entry)}
                        </strong>
                        <div className="record-actions">
                          <button type="button" className="icon-button" onClick={() => onEdit(entry)} aria-label={`编辑${entry.note || "这笔记录"}`} title="编辑">
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
    </section>
  );
}
