import { CalendarClock, Camera, Check, LoaderCircle, Minus, Plus, Trash2 } from "lucide-react";
import { useId, useRef } from "react";
import type { EntryKind } from "../domain";
import type { ImageAttachmentState } from "../hooks/useImageAttachment";

export interface EntryFieldErrors {
  amount?: string;
  note?: string;
  occurredAt?: string;
  image?: string;
  form?: string;
}

interface EntryFormFieldsProps {
  kind: EntryKind;
  amount: string;
  note: string;
  occurredAt: string;
  imageState: ImageAttachmentState;
  errors: EntryFieldErrors;
  onKindChange(kind: EntryKind): void;
  onAmountChange(value: string): void;
  onNoteChange(value: string): void;
  onOccurredAtChange(value: string): void;
}

export function EntryFormFields({
  kind,
  amount,
  note,
  occurredAt,
  imageState,
  errors,
  onKindChange,
  onAmountChange,
  onNoteChange,
  onOccurredAtChange,
}: EntryFormFieldsProps) {
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const amountErrorId = `${id}-amount-error`;
  const noteHelpId = `${id}-note-help`;
  const noteErrorId = `${id}-note-error`;
  const imageErrorId = `${id}-image-error`;
  const timeErrorId = `${id}-time-error`;

  return (
    <>
      <fieldset className="kind-switch">
        <legend className="sr-only">收支类型</legend>
        <label className={kind === "expense" ? "is-active is-expense" : ""}>
          <input
            type="radio"
            name={`${id}-kind`}
            value="expense"
            checked={kind === "expense"}
            onChange={() => onKindChange("expense")}
          />
          <Minus aria-hidden="true" />
          支出
          {kind === "expense" ? <Check className="switch-check" aria-hidden="true" /> : null}
        </label>
        <label className={kind === "income" ? "is-active is-income" : ""}>
          <input
            type="radio"
            name={`${id}-kind`}
            value="income"
            checked={kind === "income"}
            onChange={() => onKindChange("income")}
          />
          <Plus aria-hidden="true" />
          收入
          {kind === "income" ? <Check className="switch-check" aria-hidden="true" /> : null}
        </label>
      </fieldset>

      <div className={`amount-field ${errors.amount ? "has-error" : ""}`}>
        <label htmlFor={`${id}-amount`}>金额</label>
        <div className="amount-input-wrap">
          <span className={kind === "expense" ? "expense-sign" : "income-sign"} aria-hidden="true">
            {kind === "expense" ? "−" : "+"}
          </span>
          <span className="currency-mark" aria-hidden="true">¥</span>
          <input
            id={`${id}-amount`}
            data-autofocus
            value={amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-invalid={Boolean(errors.amount)}
            aria-describedby={errors.amount ? amountErrorId : undefined}
            onChange={(event) => onAmountChange(event.target.value)}
          />
        </div>
        {errors.amount ? <p className="field-error" id={amountErrorId}>{errors.amount}</p> : null}
      </div>

      <div className={`field-group ${errors.note ? "has-error" : ""}`}>
        <div className="field-label-row">
          <label htmlFor={`${id}-note`}>这笔是什么</label>
          <span id={noteHelpId}>{note.length}/200</span>
        </div>
        <textarea
          id={`${id}-note`}
          value={note}
          maxLength={200}
          rows={2}
          placeholder="例如：午饭、项目尾款"
          aria-invalid={Boolean(errors.note)}
          aria-describedby={`${noteHelpId}${errors.note ? ` ${noteErrorId}` : ""}`}
          onChange={(event) => onNoteChange(event.target.value)}
        />
        {errors.note ? <p className="field-error" id={noteErrorId}>{errors.note}</p> : null}
      </div>

      <div className={`attachment-control ${errors.image || imageState.error ? "has-error" : ""}`}>
        <input
          ref={fileInputRef}
          className="visually-hidden-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void imageState.choose(event)}
        />
        {imageState.previewUrl ? (
          <div className="image-preview">
            <img src={imageState.previewUrl} alt="账目截图预览" />
            <div className="image-preview-meta">
              <span><Check aria-hidden="true" /> 已添加截图</span>
              <button type="button" className="text-button destructive" onClick={imageState.remove}>
                <Trash2 aria-hidden="true" /> 移除
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary-button attachment-button"
            disabled={imageState.processing}
            aria-describedby={errors.image || imageState.error ? imageErrorId : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            {imageState.processing ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <Camera aria-hidden="true" />
            )}
            {imageState.processing ? "正在处理" : "添加截图"}
          </button>
        )}
        {errors.image || imageState.error ? (
          <p className="field-error" id={imageErrorId}>{errors.image ?? imageState.error}</p>
        ) : null}
      </div>

      <details className="entry-details">
        <summary>
          <span><CalendarClock aria-hidden="true" /> 记录时间</span>
          <span className="details-value">{occurredAt.replace("T", " ")}</span>
        </summary>
        <div className="details-panel">
          <label htmlFor={`${id}-occurred-at`}>日期和时间</label>
          <input
            id={`${id}-occurred-at`}
            type="datetime-local"
            value={occurredAt}
            aria-invalid={Boolean(errors.occurredAt)}
            aria-describedby={errors.occurredAt ? timeErrorId : undefined}
            onChange={(event) => onOccurredAtChange(event.target.value)}
          />
          {errors.occurredAt ? <p className="field-error" id={timeErrorId}>{errors.occurredAt}</p> : null}
        </div>
      </details>
    </>
  );
}
