import { kindToSignedMinor, parseUnsignedAmountToMinor } from "./amount";
import { parseLocalDateTime } from "./date";
import type { EntryDraft, ValidatedEntryDraft } from "./types";

export const MAX_NOTE_LENGTH = 200;

export class EntryValidationError extends Error {
  constructor(
    message: string,
    public readonly field: "kind" | "amount" | "note" | "occurredAt" | "image",
  ) {
    super(message);
    this.name = "EntryValidationError";
  }
}

export function validateEntryDraft(draft: EntryDraft, hasExistingImage = false): ValidatedEntryDraft {
  if (draft.kind !== "expense" && draft.kind !== "income") {
    throw new EntryValidationError("请选择收入或支出", "kind");
  }

  let absoluteMinor: number;
  try {
    absoluteMinor = parseUnsignedAmountToMinor(draft.amount);
  } catch (error) {
    throw new EntryValidationError(error instanceof Error ? error.message : "金额无效", "amount");
  }

  const note = draft.note.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new EntryValidationError(`文字不能超过 ${MAX_NOTE_LENGTH} 个字符`, "note");
  }

  const willKeepExistingImage = hasExistingImage && !draft.removeExistingImage;
  if (!note && !draft.image && !willKeepExistingImage) {
    throw new EntryValidationError("请填写文字或添加一张截图", "note");
  }

  if (
    draft.image &&
    (!draft.image.mimeType.startsWith("image/") ||
      draft.image.blob.type !== draft.image.mimeType ||
      draft.image.blob.size !== draft.image.size ||
      draft.image.size < 1 ||
      draft.image.size > 1024 * 1024 ||
      !Number.isInteger(draft.image.width) ||
      !Number.isInteger(draft.image.height) ||
      draft.image.width < 1 ||
      draft.image.height < 1 ||
      Math.max(draft.image.width, draft.image.height) > 2048)
  ) {
    throw new EntryValidationError("截图数据无效或超出限制", "image");
  }

  let date;
  try {
    date = parseLocalDateTime(draft.occurredAtLocal);
  } catch (error) {
    throw new EntryValidationError(error instanceof Error ? error.message : "时间无效", "occurredAt");
  }

  return {
    amountMinor: kindToSignedMinor(draft.kind, absoluteMinor),
    note,
    ...date,
    image: draft.image,
    removeExistingImage: Boolean(draft.removeExistingImage),
  };
}
