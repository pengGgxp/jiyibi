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
  /**
   * Amount to set aside at the end of each pay cycle.  This is a target for
   * new retained money, not an absolute balance floor.
   *
   * It is optional for the moment so v1-v5 settings can be read while the
   * database migration is in flight.  Domain consumers should resolve the
   * value with `savingsTargetFromPlan` (new value first, legacy value second).
   */
  defaultSavingsTargetMinor?: number;
  /** @deprecated v1-v5 absolute balance-floor compatibility field. */
  cycleEndBalanceGoalMinor?: number;
}

/** One-cycle override for the default retained-money target. */
export interface CycleSavingsTargetOverride {
  /** The actual upcoming payday that this override belongs to. */
  targetPaydayDateKey: string;
  targetMinor: number;
}

export type SavingsEventKind =
  | "opening"
  | "reserve"
  | "release"
  | "cycle_settlement";

interface SavingsEventBase {
  id: string;
  /** Positive minor units; cycle settlement may be zero. */
  amountMinor: number;
  note: string;
  occurredAt: string;
  localDateKey: string;
  localMonthKey: string;
  timezoneOffsetMinutes: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface OpeningSavingsEvent extends SavingsEventBase {
  kind: "opening";
}

export interface ReserveSavingsEvent extends SavingsEventBase {
  kind: "reserve";
}

export interface ReleaseSavingsEvent extends SavingsEventBase {
  kind: "release";
  /** Optional expense this release funded directly. */
  linkedExpenseEntryId?: string;
}

export interface CycleSettlementSavingsEvent extends SavingsEventBase {
  kind: "cycle_settlement";
  /** Stable cycle identity; one active settlement is allowed per cycle. */
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  goalMinorSnapshot: number;
  openingRetainedMinor: number;
  closingRetainedMinor: number;
  netGrowthMinor: number;
  /** Compatibility spelling used by early v5 migration drafts. */
  transferToRetainedMinor?: number;
}

export type SavingsEvent =
  | OpeningSavingsEvent
  | ReserveSavingsEvent
  | ReleaseSavingsEvent
  | CycleSettlementSavingsEvent;

/** Reusable result of folding active savings events. */
export interface RetainedSavingsSummary {
  openingRetainedMinor: bigint;
  reservedMinor: bigint;
  releasedMinor: bigint;
  settledMinor: bigint;
  totalRetainedMinor: bigint;
  hasNegativeBalance: boolean;
  needsCorrection: boolean;
}

export interface CycleSavingsProgress {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  targetMinor: number;
  openingRetainedMinor: bigint;
  closingRetainedMinor: bigint;
  netGrowthMinor: bigint;
  remainingTargetMinor: bigint;
  settled: boolean;
  needsCorrection: boolean;
}

export interface SavingsHistoryPoint {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  targetMinor: number;
  netGrowthMinor: bigint;
  openingRetainedMinor: bigint;
  closingRetainedMinor: bigint;
  settled: boolean;
  needsCorrection: boolean;
}

export interface SavingsAnalysisOptions {
  /** Active savings events from IndexedDB; omitted means no retained-money view. */
  savingsEvents?: readonly SavingsEvent[];
  /** One-cycle target override, normally keyed to incomeForecast.targetPaydayDateKey. */
  targetOverride?: CycleSavingsTargetOverride;
}

export interface IncomeForecast {
  id: string;
  /** One-off expected receipt date; may be later than the recurring payday. */
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
  /** Optional target for the currently upcoming (possibly delayed) cycle. */
  savingsTargetOverride?: CycleSavingsTargetOverride;
  /** One-time prompt after a negative legacy floor was migrated to a zero target. */
  savingsTargetNeedsReview?: true;
  /** @deprecated Alias accepted while v5 clients migrate field names. */
  cycleSavingsTargetOverride?: CycleSavingsTargetOverride;
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
  /** Retained-money view; populated when savings events are supplied. */
  totalBalanceMinor?: bigint;
  retainedBalanceMinor?: bigint;
  cycleOpeningRetainedMinor?: bigint;
  cycleNetGrowthMinor?: bigint;
  savingsTargetMinor?: number;
  remainingSavingsTargetMinor?: bigint;
  spendableBalanceMinor?: bigint;
  savingsDifferenceMinor?: bigint;
  savingsAffordability?: ForecastOutcome;
  savingsNeedsCorrection?: boolean;
}

export interface IncomeScenarioAnalysis {
  incomeMinor: number;
  differenceMinor: bigint;
  affordability: ForecastOutcome;
  /** Savings target deducted from this scenario, when configured. */
  savingsTargetMinor?: number;
  spendingDifferenceMinor?: bigint;
}

export interface NextCycleAnalysis {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  nextPaydayDateKey: string;
  days: number;
  referenceSpendMinor?: number;
  defaultSavingsTargetMinor?: number;
  minimumIncomeScenario?: IncomeScenarioAnalysis;
  expectedIncomeScenario?: IncomeScenarioAnalysis;
  savingsHistory?: SavingsHistoryPoint[];
}

/**
 * A local, derived view of spending. It is never persisted or synchronized.
 * Forecast fields are absent while confidence is `insufficient`.
 */
export interface SpendingAnalysis {
  asOfDateKey: string;
  confidence: ForecastConfidence;
  window: SpendingStatisticsWindow;
  /** Ordinary-expense net amounts included in the daily-spend baseline. */
  includedExpenseMinor: number;
  /** Gross outflows present in the window but excluded from daily-spend (one-time, reimbursable, etc.). */
  excludedExpenseMinor: number;
  /** Entries still waiting on treatment confirmation. */
  pendingConfirmationCount: number;
  /** @deprecated Legacy absolute-floor output retained for old consumers. */
  cycleEndBalanceGoalMinor?: number;
  defaultSavingsTargetMinor?: number;
  retainedSavings?: RetainedSavingsSummary;
  currentSavings?: CycleSavingsProgress;
  savingsHistory?: SavingsHistoryPoint[];
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
