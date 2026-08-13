import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  currentLocalDateTimeInput,
  EntryValidationError,
  validateEntryDraft,
  type EntryDraft,
  type EntryKind,
  type LedgerEntry,
} from "../domain";
import { useImageAttachment } from "../hooks/useImageAttachment";
import { EntryFormFields, type EntryFieldErrors } from "./EntryFormFields";

interface EntryComposerProps {
  onCreate(draft: EntryDraft): Promise<LedgerEntry | void>;
  onSaved(entry?: LedgerEntry): void;
}

function validationErrors(reason: unknown): EntryFieldErrors {
  if (reason instanceof EntryValidationError) {
    if (reason.field === "kind") return { form: "请选择收入或支出" };
    const fallback = {
      amount: "请输入大于 0、最多两位小数的金额",
      note: "请填写文字或添加一张截图",
      occurredAt: "请选择有效的日期和时间",
      image: "请重新选择图片",
    }[reason.field];
    return { [reason.field]: fallback };
  }
  return { form: reason instanceof Error ? reason.message : "保存失败，请重试" };
}

export function EntryComposer({ onCreate, onSaved }: EntryComposerProps) {
  const [kind, setKind] = useState<EntryKind>("expense");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(currentLocalDateTimeInput);
  const [errors, setErrors] = useState<EntryFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const imageState = useImageAttachment();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft: EntryDraft = {
      kind,
      amount,
      note,
      occurredAtLocal: occurredAt,
      image: imageState.image,
    };

    try {
      validateEntryDraft(draft);
      setErrors({});
    } catch (reason) {
      setErrors(validationErrors(reason));
      return;
    }

    setSaving(true);
    try {
      const created = await onCreate(draft);
      setKind("expense");
      setAmount("");
      setNote("");
      setOccurredAt(currentLocalDateTimeInput());
      imageState.reset();
      setErrors({});
      onSaved(created ?? undefined);
    } catch (reason) {
      setErrors({ form: reason instanceof Error ? reason.message : "保存失败，请重试" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="composer-panel" aria-labelledby="composer-title">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">快速记录</p>
          <h2 id="composer-title">记一笔</h2>
        </div>
        <p>金额 + 文字或截图</p>
      </div>

      <form className="entry-form" onSubmit={(event) => void submit(event)} onPaste={imageState.paste} noValidate>
        <EntryFormFields
          kind={kind}
          amount={amount}
          note={note}
          occurredAt={occurredAt}
          imageState={imageState}
          errors={errors}
          onKindChange={(value) => { setKind(value); setErrors((current) => ({ ...current, amount: undefined })); }}
          onAmountChange={(value) => { setAmount(value); setErrors((current) => ({ ...current, amount: undefined, form: undefined })); }}
          onNoteChange={(value) => { setNote(value); setErrors((current) => ({ ...current, note: undefined, form: undefined })); }}
          onOccurredAtChange={(value) => { setOccurredAt(value); setErrors((current) => ({ ...current, occurredAt: undefined })); }}
        />

        {errors.form ? <p className="form-error" role="alert">{errors.form}</p> : null}
        <button className="primary-button save-entry-button" type="submit" disabled={saving || imageState.processing}>
          {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
          {saving ? "正在保存" : `保存${kind === "expense" ? "支出" : "收入"}`}
        </button>
      </form>
    </section>
  );
}
