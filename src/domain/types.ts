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

export interface PayCyclePlan {
  paydayDay: number;
  monthlySalaryMinor: number;
  cycleEndBalanceGoalMinor: number;
}

export interface AppSettings {
  id: "primary";
  currency: "CNY";
  initialBalanceMinor: number;
  /** Legacy v2 natural-month goal. Kept only for sync and backup compatibility. */
  monthEndBalanceGoalMinor?: number;
  payCycle?: PayCyclePlan;
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

export interface PayCycleStatus extends PayCyclePlan {
  targetMinor: number;
  balanceHeadroomMinor: bigint;
  isCurrentlyAtOrAboveGoal: boolean;
  cycleExpenseMinor: number;
  cycleIncomeMinor: number;
  salaryRemainingMinor: bigint;
  safeToSpendMinor: bigint;
  salarySpentPercent: number;
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  daysUntilPayday: number;
}

export type ForecastConfidence = "insufficient" | "preliminary" | "ready";

export type ForecastOutcome = "surplus" | "shortfall" | "exact";

export interface SpendingStatisticsWindow {
  startDateKey?: string;
  endDateKey: string;
  observedDays: number;
  /** Minimum completed days required before any forecast is exposed. */
  daysNeeded: number;
  totalExpenseMinor: number;
  averageDailyExpenseMinor?: number;
}

export interface DailyExpensePoint {
  dateKey: string;
  expenseMinor: number;
}

export interface CurrentCycleSpendingPoint {
  dateKey: string;
  actualCumulativeMinor?: number;
  projectedCumulativeMinor?: number;
  isPaydayBoundary: boolean;
}

export interface CompletedPayCyclePoint {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  dayCount: number;
  expenseMinor: number;
}

export interface CurrentCycleAnalysis {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  daysUntilPayday: number;
  actualExpenseMinor: number;
  balanceHeadroomMinor: bigint;
  salaryRemainingMinor: bigint;
  safeToSpendMinor: bigint;
  dailySafeToSpendMinor: bigint;
  estimatedRemainingExpenseMinor?: number;
  projectedEndBalanceMinor?: bigint;
  balanceGoalDifferenceMinor?: bigint;
  affordability?: ForecastOutcome;
}

export interface NextCycleAnalysis {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  days: number;
  estimatedExpenseMinor?: number;
  salaryDifferenceMinor?: bigint;
  affordability?: ForecastOutcome;
}

/**
 * A local, derived view of spending. It is never persisted or synchronized.
 * Forecast fields are absent while confidence is `insufficient`.
 */
export interface SpendingAnalysis {
  asOfDateKey: string;
  confidence: ForecastConfidence;
  window: SpendingStatisticsWindow;
  salaryReferenceMinor: number;
  cycleEndBalanceGoalMinor: number;
  currentCycle: CurrentCycleAnalysis;
  nextCycle: NextCycleAnalysis;
  dailyExpenses: DailyExpensePoint[];
  currentCycleSeries: CurrentCycleSpendingPoint[];
  completedCycles: CompletedPayCyclePoint[];
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
