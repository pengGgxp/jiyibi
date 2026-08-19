import {
  Banknote,
  ChevronRight,
  CircleAlert,
  PiggyBank,
  ReceiptText,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { formatCny, type PendingItem } from "../domain";
import { Modal } from "./Modal";

interface PendingQueueProps {
  items: readonly PendingItem[];
  onOpen(item: PendingItem): void;
  onSnooze(item: PendingItem): void;
}

function itemCopy(item: PendingItem): { title: string; detail: string; action: string } {
  switch (item.kind) {
    case "income_due":
      return {
        title: "确认到账",
        detail: `${item.forecast.targetPaydayDateKey.slice(5).replace("-", "/")} · ${formatCny(item.forecast.expectedIncomeMinor)}`,
        action: "去确认",
      };
    case "entry_treatment":
      return {
        title: "确认交易",
        detail: `${item.entry.note || "未写说明"} · ${formatCny(Math.abs(item.entry.amountMinor))}`,
        action: "去确认",
      };
    case "savings_penetration":
      return {
        title: "存款校正",
        detail: `建议取用 ${formatCny(item.suggestedAmountMinor)}`,
        action: "去处理",
      };
    case "recovery_link":
      return {
        title: "关联支出",
        detail: `${formatCny(item.remainingAmountMinor)} · ${item.candidateCount} 笔可选`,
        action: "去关联",
      };
  }
}

function ItemIcon({ item }: { item: PendingItem }) {
  if (item.kind === "income_due") return <Banknote aria-hidden="true" />;
  if (item.kind === "entry_treatment") return <CircleAlert aria-hidden="true" />;
  if (item.kind === "savings_penetration") return <PiggyBank aria-hidden="true" />;
  return <RotateCcw aria-hidden="true" />;
}

export function PendingQueue({ items, onOpen, onSnooze }: PendingQueueProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);
  if (items.length === 0) return null;

  return (
    <>
      <section className="pending-strip" aria-label={`${items.length} 项待处理`}>
        <span><ReceiptText aria-hidden="true" /><strong>待处理 {items.length}</strong></span>
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          查看 <ChevronRight aria-hidden="true" />
        </button>
      </section>
      <Modal open={open} title="待处理" description="处理后会自动移除。" onClose={() => setOpen(false)}>
        <ul className="pending-list">
          {items.map((item) => {
            const copy = itemCopy(item);
            return (
              <li key={item.id}>
                <span className="pending-icon"><ItemIcon item={item} /></span>
                <span className="pending-copy"><strong>{copy.title}</strong><small>{copy.detail}</small></span>
                <span className="pending-actions">
                  <button type="button" className="text-button" onClick={() => onSnooze(item)}>稍后</button>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    onClick={() => {
                      setOpen(false);
                      onOpen(item);
                    }}
                  >
                    {copy.action}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </Modal>
    </>
  );
}
