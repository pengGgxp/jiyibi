import { useEffect, useMemo, useState } from "react";
import { formatCny, type EntryTreatment, type LedgerEntry } from "../domain";
import {
  expenseTreatmentOptions,
  incomeTreatmentOptions,
  type ExceptionPromptKind,
} from "../domain/exception-prompt";
import { Modal } from "./Modal";

export interface TreatmentConfirmationDialogProps {
  entry?: LedgerEntry;
  kind: ExceptionPromptKind;
  busy?: boolean;
  error?: string;
  onConfirm(treatment: EntryTreatment): void | Promise<void>;
  onDefer(): void | Promise<void>;
  onClose(): void;
}

export function TreatmentConfirmationDialog({
  entry,
  kind,
  busy = false,
  error,
  onConfirm,
  onDefer,
}: TreatmentConfirmationDialogProps) {
  const options = useMemo(
    () => kind === "expense" ? expenseTreatmentOptions() : incomeTreatmentOptions(),
    [kind],
  );
  const defaultTreatment = kind === "expense" ? "ordinary_expense" : "ordinary_income";
  const [selected, setSelected] = useState<EntryTreatment>(defaultTreatment);

  useEffect(() => {
    setSelected(entry?.treatment && options.some((option) => option.value === entry.treatment)
      ? entry.treatment
      : defaultTreatment);
  }, [entry?.id, entry?.treatment, defaultTreatment, options]);

  if (!entry) return null;

  const title = kind === "expense" ? "这笔支出会明显影响估算" : "确认这笔资金的来源";
  const description = kind === "expense"
    ? "账目已经保存。请选择它是否代表平时的花法。"
    : "账目已经保存。这个选择只影响余额解释和统计口径。";

  return (
    <Modal open title={title} description={description} onClose={() => void onDefer()}>
      <div className="treatment-confirm">
        <p className="treatment-confirm-amount">
          {entry.amountMinor < 0 ? "支出" : "收入"} {formatCny(Math.abs(entry.amountMinor))}
          {entry.note ? <span> · {entry.note}</span> : null}
        </p>
        <div className="treatment-confirm-options" role="radiogroup" aria-label="处理方式">
          {options.map((option, index) => (
            <label
              key={option.value}
              className={`treatment-confirm-option${selected === option.value ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="treatment"
                value={option.value}
                checked={selected === option.value}
                data-autofocus={index === 0 ? true : undefined}
                disabled={busy}
                onChange={() => setSelected(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void onDefer()}
          >
            稍后处理
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void onConfirm(selected)}
          >
            {busy ? "保存中…" : "确认"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
