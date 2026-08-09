export type EntryKind = "expense" | "income";

export interface LedgerEntry {
  id: string;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  attachmentId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Attachment {
  id: string;
  entryId: string;
  blob: Blob;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface AppSettings {
  id: "primary";
  currency: "CNY";
  initialBalanceMinor: number;
  monthEndBalanceGoalMinor?: number;
  schemaVersion: 1;
  updatedAt: string;
}

export interface ProcessedImage {
  blob: Blob;
  mimeType: string;
  size: number;
  width: number;
  height: number;
}

export interface EntryDraft {
  kind: EntryKind;
  amount: string;
  note: string;
  occurredAtLocal: string;
  image?: ProcessedImage;
  removeExistingImage?: boolean;
}

export interface LedgerSummary {
  balanceMinor: number;
  monthIncomeMinor: number;
  monthExpenseMinor: number;
}

export interface MonthEndBalanceGoalStatus {
  targetMinor: number;
  differenceMinor: bigint;
  isOnTrack: boolean;
  daysRemaining: number;
  localMonthKey: string;
}

export interface ValidatedEntryDraft {
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  image?: ProcessedImage;
  removeExistingImage: boolean;
}
