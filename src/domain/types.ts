export type EntryKind = "expense" | "income";

/** Analysis semantics for a ledger entry — not a spend category. */
export type EntryTreatment =
  | "ordinary_expense"
  | "one_time_expense"
  | "reimbursable_expense"
  | "ordinary_income"
  | "refund_reimbursement"
  | "account_transfer";

export type ConfirmationStatus = "not_needed" | "pending" | "confirmed";

/** Bump when exception-detection heuristics change. */
export const CURRENT_DETECTION_RULE_VERSION = 1 as const;

export interface LedgerEntry {
  id: string;
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  attachmentId?: string;
  /** How this entry participates in balance / cashflow / daily spend. */
  treatment: EntryTreatment;
  confirmationStatus: ConfirmationStatus;
  detectionRuleVersion?: number;
  /** Entry updatedAt (or other revision token) when the user was last prompted. */
  promptedRevision?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/**
 * Single source of truth for refund/reimbursement → original expense recovery.
 * Never store mirrored copies on both entries.
 */
export interface RecoveryAllocation {
  id: string;
  refundEntryId: string;
  expenseEntryId: string;
  /** Positive minor units allocated from the refund to the expense. */
  amountMinor: number;
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
  cycleEndBalanceGoalMinor: number;
}

export interface IncomeForecast {
  id: string;
  targetPaydayDateKey: string;
  minimumIncomeMinor: number;
  expectedIncomeMinor: number;
}

export interface AppSettings {
  id: "primary";
  currency: "CNY";
  initialBalanceMinor: number;
  /** Legacy v2 natural-month goal. Kept only for sync and backup compatibility. */
  monthEndBalanceGoalMinor?: number;
  payCycle?: PayCyclePlan;
  incomeForecast?: IncomeForecast;
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
  safeToSpendMinor: bigint;
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
  safeToSpendMinor: bigint;
  dailySafeToSpendMinor: bigint;
  estimatedRemainingExpenseMinor?: number;
  projectedEndBalanceMinor?: bigint;
  balanceGoalDifferenceMinor?: bigint;
  affordability?: ForecastOutcome;
}

export interface IncomeScenarioAnalysis {
  incomeMinor: number;
  differenceMinor: bigint;
  affordability: ForecastOutcome;
}

export interface NextCycleAnalysis {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  days: number;
  referenceSpendMinor?: number;
  minimumIncomeScenario?: IncomeScenarioAnalysis;
  expectedIncomeScenario?: IncomeScenarioAnalysis;
}

/**
 * A local, derived view of spending. It is never persisted or synchronized.
 * Forecast fields are absent while confidence is `insufficient`.
 */
export interface SpendingAnalysis {
  asOfDateKey: string;
  confidence: ForecastConfidence;
  window: SpendingStatisticsWindow;
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
