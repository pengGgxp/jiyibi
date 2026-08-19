import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

export interface PendingDeletion {
  id: string;
  label: string;
}

interface UndoToastsProps {
  items: PendingDeletion[];
  children?: ReactNode;
  onUndo(id: string): void;
}

export function UndoToasts({ items, children, onUndo }: UndoToastsProps) {
  if (!items.length && !children) return null;
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions removals">
      {items.map((item) => (
        <div className="undo-toast" role="status" key={item.id}>
          <div>
            <strong>已删除</strong>
            <span>{item.label}</span>
          </div>
          <button type="button" onClick={() => onUndo(item.id)}>
            <RotateCcw aria-hidden="true" /> 撤销
          </button>
          <span className="undo-timer" aria-hidden="true" />
        </div>
      ))}
      {children}
    </div>
  );
}
