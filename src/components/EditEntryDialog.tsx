import { LoaderCircle, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { getAttachment } from "../data";
import {
  amountMinorToInput,
  entryToLocalDateTimeInput,
  EntryValidationError,
  kindFromSignedMinor,
  validateEntryDraft,
  type Attachment,
  type EntryDraft,
  type EntryKind,
  type LedgerEntry,
} from "../domain";
import { useImageAttachment } from "../hooks/useImageAttachment";
import { EntryFormFields, type EntryFieldErrors } from "./EntryFormFields";
import { Modal } from "./Modal";

interface EditEntryDialogProps {
  entry?: LedgerEntry;
  onClose(): void;
  onSave(id: string, draft: EntryDraft): Promise<void>;
}

function fieldError(reason: unknown): EntryFieldErrors {
  if (reason instanceof EntryValidationError) {
    if (reason.field === "kind") return { form: "请选择收入或支出" };
    const messages = {
      amount: "请输入大于 0、最多两位小数的金额",
      note: "请填写文字或保留一张截图",
      occurredAt: "请选择有效的日期和时间",
      image: "请重新选择图片",
    };
    return { [reason.field]: messages[reason.field] };
  }
  return { form: reason instanceof Error ? reason.message : "保存失败，请重试" };
}

export function EditEntryDialog({ entry, onClose, onSave }: EditEntryDialogProps) {
  const [kind, setKind] = useState<EntryKind>("expense");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [attachment, setAttachment] = useState<Attachment>();
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [errors, setErrors] = useState<EntryFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const imageState = useImageAttachment(attachment);

  useEffect(() => {
    if (!entry) return;
    setKind(kindFromSignedMinor(entry.amountMinor));
    setAmount(amountMinorToInput(entry.amountMinor));
    setNote(entry.note);
    setOccurredAt(entryToLocalDateTimeInput(entry.occurredAt, entry.timezoneOffsetMinutes));
    setErrors({});
    setAttachment(undefined);
    if (!entry.attachmentId) {
      setAttachmentLoading(false);
      return;
    }
    let active = true;
    setAttachmentLoading(true);
    void getAttachment(entry.attachmentId)
      .then((result) => {
        if (!active) return;
        setAttachment(result);
        if (!result) setErrors({ image: "这张截图无法读取，可替换或移除后保存" });
      })
      .catch(() => {
        if (active) setErrors({ image: "这张截图无法读取，可替换或移除后保存" });
      })
      .finally(() => {
        if (active) setAttachmentLoading(false);
      });
    return () => {
      active = false;
    };
  }, [entry]);

  if (!entry) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft: EntryDraft = {
      kind,
      amount,
      note,
      occurredAtLocal: occurredAt,
      image: imageState.image,
      removeExistingImage: imageState.removeExistingImage,
    };
    try {
      validateEntryDraft(draft, Boolean(attachment));
      setErrors({});
    } catch (reason) {
      setErrors(fieldError(reason));
      return;
    }

    setSaving(true);
    try {
      await onSave(entry.id, draft);
      onClose();
    } catch (reason) {
      setErrors(fieldError(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open title="编辑记录" description="修改后，余额和本月概览会立即重算。" onClose={onClose}>
      <form className="entry-form edit-entry-form" onSubmit={(event) => void submit(event)} onPaste={imageState.paste} noValidate>
        {attachmentLoading ? (
          <p className="edit-loading" role="status"><LoaderCircle className="spin" aria-hidden="true" /> 正在读取记录</p>
        ) : (
          <EntryFormFields
            kind={kind}
            amount={amount}
            note={note}
            occurredAt={occurredAt}
            imageState={imageState}
            errors={errors}
            onKindChange={setKind}
            onAmountChange={(value) => { setAmount(value); setErrors((current) => ({ ...current, amount: undefined, form: undefined })); }}
            onNoteChange={(value) => { setNote(value); setErrors((current) => ({ ...current, note: undefined, form: undefined })); }}
            onOccurredAtChange={(value) => { setOccurredAt(value); setErrors((current) => ({ ...current, occurredAt: undefined })); }}
          />
        )}
        {errors.form ? <p className="form-error" role="alert">{errors.form}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || imageState.processing || attachmentLoading}>
            {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
            {saving ? "正在保存" : "保存修改"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
