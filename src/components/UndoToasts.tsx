import { RotateCcw } from "lucide-react";

export interface PendingDeletion {
  id: string;
  label: string;
}

interface UndoToastsProps {
  items: PendingDeletion[];
  onUndo(id: string): void;
}

export function UndoToasts({ items, onUndo }: UndoToastsProps) {
  if (!items.length) return null;
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
    </div>
  );
}
