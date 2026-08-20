import {
  addLocalDays,
  currentLocalDateKey,
  localCalendarDayDifference,
  localDateFromKey,
  resolveFollowingPaydayDateKey,
  resolveNextPaydayDateKey,
  resolvePayCycleRange,
  listPaydayDateKeys,
} from "./date";
import {
  affectsBookBalance,
  affectsCashflow,
  isDailySpendCandidate,
  netPersonalExpenseMinor,
  normalizeLedgerEntry,
  ordinaryExpenseNetAnalysisMinor,
  unrecoveredExpenseMinor,
} from "./entry-treatment";
import type {
  AppSettings,
  BalanceAdjustment,
  CompletedPayCyclePoint,
  CurrentCycleSpendingPoint,
  DailyExpensePoint,
  ForecastConfidence,
  ForecastOutcome,
  IncomeForecast,
  IncomeScenarioAnalysis,
  LedgerEntry,
  LedgerSummary,
  PayCyclePlan,
  PayCycleStatus,
  RecoveryAllocation,
  CycleSavingsTargetOverride,
  CycleSavingsProgress,
  RetainedSavingsSummary,
  SpendingAnalysis,
  SpendingStatisticsWindow,
  SavingsAnalysisOptions,
  SavingsEvent,
  SavingsHistoryPoint,
  SavingsGoal,
  SavingsGoalProgress,
} from "./types";

const MINIMUM_FORECAST_DAYS = 14;
const READY_FORECAST_DAYS = 30;
const COMPLETED_CYCLE_COUNT = 6;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Resolve the new retained-money target while still being able to read a
 * pre-v6 settings row.  New settings are never allowed to carry a negative
 * target; a legacy absolute-floor value is returned as-is for old callers so
 * their historical analysis remains readable during migration.
 */
export function savingsTargetFromPlan(plan: PayCyclePlan): number {
  if (plan.defaultSavingsTargetMinor !== undefined) {
    if (
      !Number.isSafeInteger(plan.defaultSavingsTargetMinor)
      || plan.defaultSavingsTargetMinor < 0
    ) {
      throw new RangeError("每周期留存目标必须是非负整数分");
    }
    return plan.defaultSavingsTargetMinor;
  }
  // v6 plans no longer carry a per-cycle target.  Treat an absent legacy
  // field as zero while old rows are being migrated.
  if (plan.cycleEndBalanceGoalMinor === undefined) return 0;
  if (
    plan.cycleEndBalanceGoalMinor === undefined
    || !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
  ) {
    throw new RangeError("工资周期必须设置每周期留存目标");
  }
  return plan.cycleEndBalanceGoalMinor;
}

function nonNegativeSavingsTargetFromPlan(plan: PayCyclePlan): number {
  const target = savingsTargetFromPlan(plan);
  // Negative legacy floors cannot express a retained-money target.  The v5
  // migration maps them to zero; doing the same here keeps mixed-version
  // analysis deterministic without mutating the settings row.
  return target < 0 ? 0 : target;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("账目合计超出安全范围");
  }
  return result;
}

function safeMinorFromBigInt(value: bigint, message: string): number {
  if (value < 0n || value > MAX_SAFE_MINOR) throw new RangeError(message);
  return Number(value);
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError("预测比例必须使用非负数和正数除数");
  }
  return (numerator + denominator / 2n) / denominator;
}

function scaledExpense(totalMinor: number, days: number, sourceDayCount: number): number {
  const result = roundedRatio(
    BigInt(totalMinor) * BigInt(days),
    BigInt(sourceDayCount),
  );
  return safeMinorFromBigInt(result, "预测支出超出安全范围");
}

function outcomeFromDifference(differenceMinor: bigint): ForecastOutcome {
  if (differenceMinor > 0n) return "surplus";
  if (differenceMinor < 0n) return "shortfall";
  return "exact";
}

function assertAnalysisInputs(balanceMinor: number, plan: PayCyclePlan): void {
  if (
    !Number.isSafeInteger(balanceMinor) ||
    !Number.isInteger(plan.paydayDay) ||
    plan.paydayDay < 1 ||
    plan.paydayDay > 31
  ) {
    throw new RangeError("分析金额和工资周期必须使用有效的整数分");
  }
  // Resolve here so a missing/invalid target fails before any date work.
  savingsTargetFromPlan(plan);
}

function assertIncomeForecast(forecast: IncomeForecast): void {
  localDateFromKey(forecast.targetPaydayDateKey);
  if (forecast.minimumIncomeMinor === undefined) {
    if (
      forecast.id.trim().length === 0 ||
      !Number.isSafeInteger(forecast.expectedIncomeMinor) ||
      forecast.expectedIncomeMinor < 0
    ) {
      throw new RangeError("invalid income forecast");
    }
    return;
  }
  if (
    forecast.id.trim().length === 0 ||
    !Number.isSafeInteger(forecast.minimumIncomeMinor) ||
    forecast.minimumIncomeMinor < 0 ||
    !Number.isSafeInteger(forecast.expectedIncomeMinor) ||
    forecast.expectedIncomeMinor < forecast.minimumIncomeMinor
  ) {
    throw new RangeError("收入预期必须使用有效的非负整数分，且最低收入不能高于预计收入");
  }
}

function incomeScenario(
  incomeMinor: number,
  referenceSpendMinor: number,
  savingsTargetMinor?: number,
): IncomeScenarioAnalysis {
  if (!Number.isSafeInteger(incomeMinor) || incomeMinor < 0) {
    throw new RangeError("收入场景必须是非负整数分");
  }
  if (!Number.isSafeInteger(referenceSpendMinor) || referenceSpendMinor < 0) {
    throw new RangeError("参考支出必须是非负整数分");
  }
  if (
    savingsTargetMinor !== undefined
    && (!Number.isSafeInteger(savingsTargetMinor) || savingsTargetMinor < 0)
  ) {
    throw new RangeError("留存目标必须是非负整数分");
  }
  const spendingDifferenceMinor = BigInt(incomeMinor) - BigInt(referenceSpendMinor);
  const differenceMinor = spendingDifferenceMinor - BigInt(savingsTargetMinor ?? 0);
  return {
    incomeMinor,
    differenceMinor,
    affordability: outcomeFromDifference(differenceMinor),
    ...(savingsTargetMinor !== undefined
      ? { savingsTargetMinor, spendingDifferenceMinor }
      : {}),
  };
}

function assertSavingsEvent(event: SavingsEvent): void {
  if (
    !event.id.trim()
    || !Number.isSafeInteger(event.amountMinor)
    || event.amountMinor < 0
    || (event.kind !== "cycle_settlement" && event.amountMinor === 0)
  ) {
    throw new RangeError("留存事件金额必须是有效的整数分");
  }
  localDateFromKey(event.localDateKey);
  if (!event.occurredAt || !event.createdAt || !event.updatedAt) {
    throw new RangeError("留存事件时间不能为空");
  }
  if (event.kind !== "cycle_settlement") return;

  localDateFromKey(event.cycleStartDateKey);
  localDateFromKey(event.cycleEndDateKey);
  if (event.cycleStartDateKey > event.cycleEndDateKey) {
    throw new RangeError("留存结算周期范围无效");
  }
  for (const value of [
    event.goalMinorSnapshot,
    event.openingRetainedMinor,
    event.closingRetainedMinor,
    event.netGrowthMinor,
  ]) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("留存结算快照必须使用安全整数分");
    }
  }
  if (event.goalMinorSnapshot < 0) {
    throw new RangeError("留存结算目标不能为负数");
  }
  if (
    event.transferToRetainedMinor !== undefined
    && event.transferToRetainedMinor !== event.amountMinor
  ) {
    throw new RangeError("留存结算金额字段不一致");
  }
}

function activeSavingsEvents(events: readonly SavingsEvent[]): SavingsEvent[] {
  const active: SavingsEvent[] = [];
  for (const event of events) {
    assertSavingsEvent(event);
    if (!event.deletedAt) active.push(event);
  }
  active.sort((left, right) => {
    const dateOrder = left.localDateKey.localeCompare(right.localDateKey);
    return dateOrder || left.id.localeCompare(right.id);
  });
  return active;
}

type SettlementSavingsEvent = Extract<SavingsEvent, { kind: "cycle_settlement" }>;

function settlementEventsEndingOn(
  active: readonly SavingsEvent[],
  cycleEndDateKey: string,
): SettlementSavingsEvent[] {
  return active.filter(
    (event): event is SettlementSavingsEvent =>
      event.kind === "cycle_settlement"
      && event.cycleEndDateKey === cycleEndDateKey,
  );
}

function previousCompletedCycleRange(
  paydayDay: number,
  cursorDateKey: string,
  active: readonly SavingsEvent[],
) {
  const exactSettlements = settlementEventsEndingOn(active, cursorDateKey)
    .sort((left, right) => left.id.localeCompare(right.id));
  const exact = exactSettlements[0];
  if (exact) {
    return {
      cycleStartDateKey: exact.cycleStartDateKey,
      cycleEndDateKey: exact.cycleEndDateKey,
      nextPaydayDateKey: addLocalDays(exact.cycleEndDateKey, 1),
      daysUntilPayday: 0,
    };
  }
  return resolvePayCycleRange(paydayDay, localDateFromKey(cursorDateKey));
}

function currentCycleRangeFromSettlements(
  plan: PayCyclePlan,
  now: Date,
  todayDateKey: string,
  events: readonly SavingsEvent[],
) {
  const regularRange = resolvePayCycleRange(plan.paydayDay, now);
  const active = activeSavingsEvents(events);
  const latestCompletedSettlement = active
    .filter(
      (event): event is SettlementSavingsEvent =>
        event.kind === "cycle_settlement"
        && event.cycleEndDateKey < todayDateKey
        && event.localDateKey <= todayDateKey,
    )
    .sort((left, right) =>
      right.cycleEndDateKey.localeCompare(left.cycleEndDateKey)
      || right.updatedAt.localeCompare(left.updatedAt)
      || right.id.localeCompare(left.id),
    )[0];
  if (!latestCompletedSettlement) return regularRange;

  const actualCycleStartDateKey = addLocalDays(
    latestCompletedSettlement.cycleEndDateKey,
    1,
  );
  if (
    actualCycleStartDateKey <= regularRange.cycleStartDateKey
    || actualCycleStartDateKey > todayDateKey
    || actualCycleStartDateKey >= regularRange.nextPaydayDateKey
  ) return regularRange;

  return {
    ...regularRange,
    cycleStartDateKey: actualCycleStartDateKey,
  };
}

function savingsEventDelta(event: SavingsEvent): bigint {
  const amount = event.kind === "cycle_settlement" && event.transferToRetainedMinor !== undefined
    ? event.transferToRetainedMinor
    : event.amountMinor;
  const delta = BigInt(amount);
  return event.kind === "release" ? -delta : delta;
}

/** Fold active retained-money events without changing the ledger balance. */
export function calculateRetainedSavingsSummary(
  events: readonly SavingsEvent[],
): RetainedSavingsSummary {
  const active = activeSavingsEvents(events);
  let openingRetainedMinor = 0n;
  let reservedMinor = 0n;
  let releasedMinor = 0n;
  let settledMinor = 0n;
  let totalRetainedMinor = 0n;
  let needsCorrection = false;
  let openingCount = 0;
  const settlementCycles = new Set<string>();

  for (const event of active) {
    const amount = BigInt(
      event.kind === "cycle_settlement" && event.transferToRetainedMinor !== undefined
        ? event.transferToRetainedMinor
        : event.amountMinor,
    );
    if (event.kind === "opening") {
      openingCount += 1;
      openingRetainedMinor += amount;
      if (openingCount > 1) needsCorrection = true;
    }
    if (event.kind === "reserve") reservedMinor += amount;
    if (event.kind === "release") releasedMinor += amount;
    if (event.kind === "cycle_settlement") {
      settledMinor += amount;
      if (settlementCycles.has(event.cycleStartDateKey)) needsCorrection = true;
      settlementCycles.add(event.cycleStartDateKey);
    }
    totalRetainedMinor += savingsEventDelta(event);
  }

  const hasNegativeBalance = totalRetainedMinor < 0n;
  return {
    openingRetainedMinor,
    reservedMinor,
    releasedMinor,
    settledMinor,
    totalRetainedMinor,
    hasNegativeBalance,
    needsCorrection: needsCorrection || hasNegativeBalance,
  };
}

/**
 * Derive progress for the single cumulative savings goal.  The goal never
 * reserves money by itself; retainedMinor comes exclusively from saved-money
 * events.  A per-payday suggestion is exposed only while the goal is active
 * and at least one configured payday remains in the inclusive date range.
 */
export function calculateSavingsGoalProgress(
  goal: SavingsGoal,
  retained: RetainedSavingsSummary | bigint,
  paydayDay: number | undefined,
  now = new Date(),
): SavingsGoalProgress {
  localDateFromKey(goal.targetDateKey);
  if (
    !Number.isSafeInteger(goal.targetMinor) ||
    goal.targetMinor < 0 ||
    goal.targetMinor > Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(now.getTime())
  ) {
    throw new RangeError("invalid savings goal");
  }
  const summary = typeof retained === "bigint" ? undefined : retained;
  const retainedMinor = typeof retained === "bigint"
    ? retained
    : retained.totalRetainedMinor;
  const remainingMinor = BigInt(goal.targetMinor) > retainedMinor
    ? BigInt(goal.targetMinor) - retainedMinor
    : 0n;
  const todayDateKey = currentLocalDateKey(now);
  const status = remainingMinor === 0n
    ? "completed" as const
    : goal.targetDateKey < todayDateKey
      ? "overdue" as const
      : "active" as const;
  const paydays = status === "active" && paydayDay !== undefined
    ? listPaydayDateKeys(paydayDay, todayDateKey, goal.targetDateKey)
    : [];
  const remainingPaydayCount = paydays.length > 0 ? paydays.length : undefined;
  const suggestedPerCycleMinor = remainingPaydayCount === undefined
    ? undefined
    : (remainingMinor + BigInt(remainingPaydayCount) - 1n) /
      BigInt(remainingPaydayCount);

  return {
    targetDateKey: goal.targetDateKey,
    targetMinor: goal.targetMinor,
    retainedMinor,
    remainingMinor,
    status,
    ...(remainingPaydayCount === undefined
      ? {}
      : { remainingPaydayCount, suggestedPerCycleMinor }),
    needsCorrection: summary?.needsCorrection ?? retainedMinor < 0n,
  };
}

function retainedTotalThrough(
  active: readonly SavingsEvent[],
  endDateKey: string,
): bigint {
  let total = 0n;
  for (const event of active) {
    if (event.localDateKey <= endDateKey) total += savingsEventDelta(event);
  }
  return total;
}

function retainedTotalBefore(
  active: readonly SavingsEvent[],
  startDateKey: string,
): bigint {
  let total = 0n;
  for (const event of active) {
    if (event.localDateKey < startDateKey) total += savingsEventDelta(event);
  }
  return total;
}

function cycleOpeningRetained(
  active: readonly SavingsEvent[],
  cycleStartDateKey: string,
  asOfDateKey: string,
): bigint {
  let total = retainedTotalBefore(active, cycleStartDateKey);
  // Opening records and late corrections of earlier cycle settlements both
  // describe money that already existed at this cycle's start. Their recorded
  // date must not turn them into new savings for the current cycle.
  for (const event of active) {
    if (
      event.localDateKey >= cycleStartDateKey
      && event.localDateKey <= asOfDateKey
      && (
        event.kind === "opening"
        || (
          event.kind === "cycle_settlement"
          && event.cycleEndDateKey < cycleStartDateKey
        )
      )
    ) {
      total += savingsEventDelta(event);
    }
  }
  return total;
}

function savingsTargetForPayday(
  plan: PayCyclePlan,
  nextPaydayDateKey: string,
  override?: CycleSavingsTargetOverride,
): number {
  if (override !== undefined) {
    localDateFromKey(override.targetPaydayDateKey);
    if (
      !Number.isSafeInteger(override.targetMinor)
      || override.targetMinor < 0
    ) {
      throw new RangeError("本周期留存目标必须是非负整数分");
    }
    if (override.targetPaydayDateKey === nextPaydayDateKey) return override.targetMinor;
  }
  return nonNegativeSavingsTargetFromPlan(plan);
}

/**
 * Derive the retained-money progress for one cycle. `asOfDateKey` lets the
 * current cycle use today's events while completed cycles use their end date.
 */
export function calculateCycleSavingsProgress(
  events: readonly SavingsEvent[],
  plan: PayCyclePlan,
  cycleStartDateKey: string,
  cycleEndDateKey: string,
  nextPaydayDateKey: string,
  asOfDateKey = cycleEndDateKey,
  override?: CycleSavingsTargetOverride,
): CycleSavingsProgress {
  localDateFromKey(cycleStartDateKey);
  localDateFromKey(cycleEndDateKey);
  localDateFromKey(nextPaydayDateKey);
  localDateFromKey(asOfDateKey);
  if (cycleStartDateKey > cycleEndDateKey || cycleEndDateKey >= nextPaydayDateKey) {
    throw new RangeError("留存周期日期范围无效");
  }
  const active = activeSavingsEvents(events);
  const boundedAsOf = asOfDateKey < cycleStartDateKey
    ? addLocalDays(cycleStartDateKey, -1)
    : asOfDateKey > cycleEndDateKey ? cycleEndDateKey : asOfDateKey;
  const openingRetainedMinor = cycleOpeningRetained(
    active,
    cycleStartDateKey,
    boundedAsOf,
  );
  const closingRetainedMinor = retainedTotalThrough(active, boundedAsOf);
  const netGrowthMinor = closingRetainedMinor - openingRetainedMinor;
  const targetMinor = savingsTargetForPayday(plan, nextPaydayDateKey, override);
  const remainingTargetMinor = BigInt(targetMinor) > netGrowthMinor
    ? BigInt(targetMinor) - netGrowthMinor
    : 0n;
  const matchingSettlements = active.filter(
    (event): event is Extract<SavingsEvent, { kind: "cycle_settlement" }> =>
      event.kind === "cycle_settlement"
      && event.cycleStartDateKey === cycleStartDateKey,
  );
  const hasNegativeBalance = closingRetainedMinor < 0n;
  return {
    cycleStartDateKey,
    cycleEndDateKey,
    nextPaydayDateKey,
    targetMinor,
    openingRetainedMinor,
    closingRetainedMinor,
    netGrowthMinor,
    remainingTargetMinor,
    settled: matchingSettlements.length > 0,
    needsCorrection: hasNegativeBalance || matchingSettlements.length > 1,
  };
}

/** Build up to six completed cycle retained-money points for the chart. */
export function calculateSavingsHistory(
  events: readonly SavingsEvent[],
  plan: PayCyclePlan,
  currentCycleStartDateKey: string,
  count = COMPLETED_CYCLE_COUNT,
): SavingsHistoryPoint[] {
  if (!Number.isInteger(count) || count < 0 || count > 24) {
    throw new RangeError("留存历史周期数量无效");
  }
  localDateFromKey(currentCycleStartDateKey);
  const active = activeSavingsEvents(events);
  if (active.length === 0 || count === 0) return [];
  const earliestEventDateKey = active.reduce(
    (earliest, event) => {
      const eventStartDateKey = event.kind === "cycle_settlement"
        ? event.cycleStartDateKey
        : event.localDateKey;
      return eventStartDateKey < earliest ? eventStartDateKey : earliest;
    },
    active[0].kind === "cycle_settlement"
      ? active[0].cycleStartDateKey
      : active[0].localDateKey,
  );
  const points: SavingsHistoryPoint[] = [];
  let cursorDateKey = addLocalDays(currentCycleStartDateKey, -1);
  for (let index = 0; index < count; index += 1) {
    const range = previousCompletedCycleRange(plan.paydayDay, cursorDateKey, active);
    if (range.cycleEndDateKey < earliestEventDateKey) break;
    const derivedOpeningRetainedMinor = cycleOpeningRetained(
      active,
      range.cycleStartDateKey,
      range.cycleEndDateKey,
    );
    const derivedClosingRetainedMinor = retainedTotalThrough(active, range.cycleEndDateKey);
    const settlements = active.filter(
      (event): event is SettlementSavingsEvent =>
        event.kind === "cycle_settlement"
        && event.cycleStartDateKey === range.cycleStartDateKey,
    );
    const settlement = settlements.length === 1 ? settlements[0] : undefined;
    const targetMinor = settlement?.goalMinorSnapshot
      ?? nonNegativeSavingsTargetFromPlan(plan);
    const openingRetainedMinor = settlement
      ? BigInt(settlement.openingRetainedMinor)
      : derivedOpeningRetainedMinor;
    const closingRetainedMinor = settlement
      ? BigInt(settlement.closingRetainedMinor)
      : derivedClosingRetainedMinor;
    const netGrowthMinor = settlement
      ? BigInt(settlement.netGrowthMinor)
      : closingRetainedMinor - openingRetainedMinor;
    const inconsistentSnapshot = settlement !== undefined
      && closingRetainedMinor - openingRetainedMinor !== netGrowthMinor;
    points.push({
      cycleStartDateKey: range.cycleStartDateKey,
      cycleEndDateKey: range.cycleEndDateKey,
      targetMinor,
      netGrowthMinor,
      openingRetainedMinor,
      closingRetainedMinor,
      settled: settlements.length > 0,
      needsCorrection:
        closingRetainedMinor < 0n
        || settlements.length > 1
        || inconsistentSnapshot,
    });
    cursorDateKey = addLocalDays(range.cycleStartDateKey, -1);
  }
  return points.reverse();
}

interface AnalysisEntries {
  expenseByDate: Map<string, number>;
  earliestCompletedEntryDateKey?: string;
}

function prepareAnalysisEntries(
  entries: readonly LedgerEntry[],
  todayDateKey: string,
  yesterdayDateKey: string,
  allocations: readonly RecoveryAllocation[] = [],
): AnalysisEntries {
  const expenseByDate = new Map<string, number>();
  let earliestCompletedEntryDateKey: string | undefined;

  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (entry.deletedAt) continue;
    // Parsing also prevents lexicographic comparisons from accepting malformed keys.
    localDateFromKey(entry.localDateKey);
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
      throw new RangeError("账目金额必须使用非零整数分");
    }
    if (entry.localDateKey > todayDateKey) continue;
    // Only daily-spend candidates open the window and enter the baseline.
    // Income, transfers, one-offs, and reimbursable pads are excluded.
    if (!isDailySpendCandidate(entry)) continue;

    const expenseMinor = ordinaryExpenseNetAnalysisMinor(entry, allocations);
    if (expenseMinor <= 0) continue;

    if (entry.localDateKey <= yesterdayDateKey) {
      earliestCompletedEntryDateKey = earliestCompletedEntryDateKey === undefined
        || entry.localDateKey < earliestCompletedEntryDateKey
        ? entry.localDateKey
        : earliestCompletedEntryDateKey;
    }

    expenseByDate.set(
      entry.localDateKey,
      safeAdd(expenseByDate.get(entry.localDateKey) ?? 0, expenseMinor),
    );
  }

  return { expenseByDate, earliestCompletedEntryDateKey };
}

/** Gross external outflows by date (cashflow/charts), not the daily-spend baseline. */
function prepareGrossExpenseByDate(
  entries: readonly LedgerEntry[],
  todayDateKey: string,
): Map<string, number> {
  const expenseByDate = new Map<string, number>();
  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (entry.deletedAt) continue;
    localDateFromKey(entry.localDateKey);
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
      throw new RangeError("账目金额必须使用非零整数分");
    }
    if (entry.localDateKey > todayDateKey) continue;
    if (!affectsCashflow(entry) || entry.amountMinor >= 0) continue;
    const expenseMinor = Math.abs(entry.amountMinor);
    expenseByDate.set(
      entry.localDateKey,
      safeAdd(expenseByDate.get(entry.localDateKey) ?? 0, expenseMinor),
    );
  }
  return expenseByDate;
}

function expenseInRange(
  expenseByDate: ReadonlyMap<string, number>,
  startDateKey: string,
  endDateKey: string,
): number {
  let totalMinor = 0;
  for (const [dateKey, expenseMinor] of expenseByDate) {
    if (dateKey >= startDateKey && dateKey <= endDateKey) {
      totalMinor = safeAdd(totalMinor, expenseMinor);
    }
  }
  return totalMinor;
}

function buildDailyExpenses(
  expenseByDate: ReadonlyMap<string, number>,
  startDateKey: string | undefined,
  endDateKey: string,
): DailyExpensePoint[] {
  if (!startDateKey) return [];
  const points: DailyExpensePoint[] = [];
  const dayCount = localCalendarDayDifference(startDateKey, endDateKey) + 1;
  for (let offset = 0; offset < dayCount; offset += 1) {
    const dateKey = addLocalDays(startDateKey, offset);
    points.push({ dateKey, expenseMinor: expenseByDate.get(dateKey) ?? 0 });
  }
  return points;
}

/**
 * Build the completed-day ordinary-spend window without requiring a pay-cycle
 * plan. Exception detection uses this when forecasting has not been enabled.
 */
export function calculateSpendingStatisticsWindow(
  entries: readonly LedgerEntry[],
  allocations: readonly RecoveryAllocation[] = [],
  now = new Date(),
): SpendingStatisticsWindow {
  const todayDateKey = currentLocalDateKey(now);
  const yesterdayDateKey = addLocalDays(todayDateKey, -1);
  const prepared = prepareAnalysisEntries(
    entries,
    todayDateKey,
    yesterdayDateKey,
    allocations,
  );
  const windowStartCandidate = addLocalDays(yesterdayDateKey, -29);
  const startDateKey = prepared.earliestCompletedEntryDateKey === undefined
    ? undefined
    : prepared.earliestCompletedEntryDateKey > windowStartCandidate
      ? prepared.earliestCompletedEntryDateKey
      : windowStartCandidate;
  const observedDays = startDateKey === undefined
    ? 0
    : localCalendarDayDifference(startDateKey, yesterdayDateKey) + 1;
  const totalExpenseMinor = startDateKey === undefined
    ? 0
    : expenseInRange(prepared.expenseByDate, startDateKey, yesterdayDateKey);
  const averageDailyExpenseMinor = observedDays > 0
    ? scaledExpense(totalExpenseMinor, 1, observedDays)
    : undefined;

  return {
    ...(startDateKey ? { startDateKey } : {}),
    endDateKey: yesterdayDateKey,
    observedDays,
    daysNeeded: MINIMUM_FORECAST_DAYS,
    totalExpenseMinor,
    ...(averageDailyExpenseMinor !== undefined ? { averageDailyExpenseMinor } : {}),
  };
}

function completedPayCycles(
  expenseByDate: ReadonlyMap<string, number>,
  paydayDay: number,
  currentCycleStartDateKey: string,
  observationStartDateKey: string | undefined,
  savingsEvents: readonly SavingsEvent[] = [],
): CompletedPayCyclePoint[] {
  const cycles: CompletedPayCyclePoint[] = [];
  const activeSavings = activeSavingsEvents(savingsEvents);
  let cursorDateKey = addLocalDays(currentCycleStartDateKey, -1);
  for (let index = 0; index < COMPLETED_CYCLE_COUNT; index += 1) {
    const range = previousCompletedCycleRange(paydayDay, cursorDateKey, activeSavings);
    // A partial first cycle cannot be compared safely: dates before the first
    // observed entry are unknown rather than zero-spend days.
    if (
      observationStartDateKey === undefined
      || range.cycleStartDateKey < observationStartDateKey
    ) {
      break;
    }
    cycles.push({
      cycleStartDateKey: range.cycleStartDateKey,
      cycleEndDateKey: range.cycleEndDateKey,
      dayCount: localCalendarDayDifference(
        range.cycleStartDateKey,
        range.nextPaydayDateKey,
      ),
      expenseMinor: expenseInRange(
        expenseByDate,
        range.cycleStartDateKey,
        range.cycleEndDateKey,
      ),
    });
    cursorDateKey = addLocalDays(range.cycleStartDateKey, -1);
  }
  return cycles.reverse();
}

function currentCycleSpendingSeries(
  expenseByDate: ReadonlyMap<string, number>,
  cycleStartDateKey: string,
  todayDateKey: string,
  nextPaydayDateKey: string,
  estimatedRemainingExpenseMinor: number | undefined,
): CurrentCycleSpendingPoint[] {
  const points: CurrentCycleSpendingPoint[] = [];
  const elapsedDayCount = localCalendarDayDifference(cycleStartDateKey, todayDateKey) + 1;
  let actualCumulativeMinor = 0;
  for (let offset = 0; offset < elapsedDayCount; offset += 1) {
    const dateKey = addLocalDays(cycleStartDateKey, offset);
    actualCumulativeMinor = safeAdd(
      actualCumulativeMinor,
      expenseByDate.get(dateKey) ?? 0,
    );
    const point: CurrentCycleSpendingPoint = {
      dateKey,
      actualCumulativeMinor,
      isPaydayBoundary: false,
    };
    if (dateKey === todayDateKey && estimatedRemainingExpenseMinor !== undefined) {
      point.projectedCumulativeMinor = actualCumulativeMinor;
    }
    points.push(point);
  }

  if (estimatedRemainingExpenseMinor === undefined) return points;
  const forecastDayCount = localCalendarDayDifference(todayDateKey, nextPaydayDateKey);
  if (forecastDayCount === 0) {
    const boundaryPoint = points.at(-1);
    if (boundaryPoint) {
      boundaryPoint.projectedCumulativeMinor = safeAdd(
        actualCumulativeMinor,
        estimatedRemainingExpenseMinor,
      );
      boundaryPoint.isPaydayBoundary = true;
    }
    return points;
  }
  for (let offset = 1; offset <= forecastDayCount; offset += 1) {
    const projectedIncrease = safeMinorFromBigInt(
      roundedRatio(
        BigInt(estimatedRemainingExpenseMinor) * BigInt(offset),
        BigInt(forecastDayCount),
      ),
      "累计预测支出超出安全范围",
    );
    points.push({
      dateKey: addLocalDays(todayDateKey, offset),
      projectedCumulativeMinor: safeAdd(actualCumulativeMinor, projectedIncrease),
      isPaydayBoundary: offset === forecastDayCount,
    });
  }
  return points;
}

export function calculateLedgerSummary(
  entries: readonly LedgerEntry[],
  settings: Pick<AppSettings, "initialBalanceMinor">,
  monthKey: string,
  balanceAdjustments: readonly BalanceAdjustment[] = [],
  allocations: readonly RecoveryAllocation[] = [],
): LedgerSummary {
  let balanceMinor = settings.initialBalanceMinor;
  let monthIncomeMinor = 0;
  let monthExpenseMinor = 0;
  let monthCashInMinor = 0;
  let monthCashOutMinor = 0;

  for (const adjustment of balanceAdjustments) {
    if (!adjustment.deletedAt) {
      balanceMinor = safeAdd(balanceMinor, adjustment.amountMinor);
    }
  }

  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (entry.deletedAt) continue;
    if (affectsBookBalance(entry)) {
      balanceMinor = safeAdd(balanceMinor, entry.amountMinor);
    }
    if (entry.localMonthKey !== monthKey) continue;
    if (affectsCashflow(entry)) {
      if (entry.amountMinor > 0) {
        monthCashInMinor = safeAdd(monthCashInMinor, entry.amountMinor);
      } else {
        monthCashOutMinor = safeAdd(monthCashOutMinor, Math.abs(entry.amountMinor));
      }
    }
    if (entry.treatment === "ordinary_income" && entry.amountMinor > 0) {
      monthIncomeMinor = safeAdd(monthIncomeMinor, entry.amountMinor);
    } else if (entry.amountMinor < 0) {
      monthExpenseMinor = safeAdd(
        monthExpenseMinor,
        netPersonalExpenseMinor(entry, allocations),
      );
    }
  }

  return {
    balanceMinor,
    monthIncomeMinor,
    monthExpenseMinor,
    monthCashInMinor,
    monthCashOutMinor,
  };
}

export function payCyclePlanFromSettings(
  settings: AppSettings | undefined,
): PayCyclePlan | undefined {
  const plan = settings?.payCycle;
  if (
    !plan ||
    !Number.isInteger(plan.paydayDay) ||
    plan.paydayDay < 1 ||
    plan.paydayDay > 31
  ) {
    return undefined;
  }
  return plan;
}

export function calculatePayCycleStatus(
  entries: readonly LedgerEntry[],
  balanceMinor: number,
  plan: PayCyclePlan,
  now = new Date(),
): PayCycleStatus {
  if (!Number.isSafeInteger(balanceMinor)) {
    throw new RangeError("工资周期金额必须使用整数分");
  }
  const targetMinor = savingsTargetFromPlan(plan);
  const range = resolvePayCycleRange(plan.paydayDay, now);
  let cycleExpenseMinor = 0;
  let cycleIncomeMinor = 0;
  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (
      entry.deletedAt ||
      !affectsCashflow(entry) ||
      entry.localDateKey < range.cycleStartDateKey ||
      entry.localDateKey > range.cycleEndDateKey
    ) {
      continue;
    }
    if (entry.amountMinor > 0) {
      cycleIncomeMinor = safeAdd(cycleIncomeMinor, entry.amountMinor);
    } else {
      cycleExpenseMinor = safeAdd(cycleExpenseMinor, Math.abs(entry.amountMinor));
    }
  }

  const balanceHeadroomMinor = BigInt(balanceMinor) - BigInt(targetMinor);
  return {
    ...plan,
    targetMinor,
    balanceHeadroomMinor,
    isCurrentlyAtOrAboveGoal: balanceHeadroomMinor >= 0n,
    cycleExpenseMinor,
    cycleIncomeMinor,
    safeToSpendMinor: balanceHeadroomMinor > 0n ? balanceHeadroomMinor : 0n,
    ...range,
  };
}

/** Total money immediately available for spending after actual retained funds. */
export function calculateSpendableBalanceMinor(
  balanceMinor: number,
  retained: RetainedSavingsSummary | bigint,
): bigint {
  if (!Number.isSafeInteger(balanceMinor)) {
    throw new RangeError("balance must use safe integer minor units");
  }
  const retainedMinor = typeof retained === "bigint"
    ? retained
    : retained.totalRetainedMinor;
  return BigInt(balanceMinor) - retainedMinor;
}

/**
 * Derives lightweight spending forecasts from local ledger entries.
 * The result is intentionally not persisted: changing an entry or the local
 * date immediately changes the analysis.
 */
export function calculateSpendingAnalysis(
  entries: readonly LedgerEntry[],
  balanceMinor: number,
  plan: PayCyclePlan,
  incomeForecast: IncomeForecast | undefined,
  now = new Date(),
  allocations: readonly RecoveryAllocation[] = [],
  savingsInput?: readonly SavingsEvent[] | SavingsAnalysisOptions,
  targetOverride?: CycleSavingsTargetOverride,
): SpendingAnalysis {
  assertAnalysisInputs(balanceMinor, plan);
  if (incomeForecast) assertIncomeForecast(incomeForecast);
  if (!Number.isFinite(now.getTime())) throw new RangeError("分析日期无效");

  const isSavingsEventArray = (
    value: readonly SavingsEvent[] | SavingsAnalysisOptions | undefined,
  ): value is readonly SavingsEvent[] => Array.isArray(value);
  const hasSavingsInput = savingsInput !== undefined;
  const savingsEvents: readonly SavingsEvent[] = isSavingsEventArray(savingsInput)
    ? savingsInput
    : savingsInput?.savingsEvents ?? [];
  const effectiveTargetOverride = targetOverride
    ?? (isSavingsEventArray(savingsInput) ? undefined : savingsInput?.targetOverride);
  const cumulativeSavingsGoal = isSavingsEventArray(savingsInput)
    ? undefined
    : savingsInput?.savingsGoal;

  const todayDateKey = currentLocalDateKey(now);
  const yesterdayDateKey = addLocalDays(todayDateKey, -1);
  // Daily-spend baseline (ordinary expenses net of recovery).
  const prepared = prepareAnalysisEntries(
    entries,
    todayDateKey,
    yesterdayDateKey,
    allocations,
  );
  // Gross external outflows for cycle actuals / completed-cycle charts.
  const grossExpenseByDate = prepareGrossExpenseByDate(entries, todayDateKey);
  const grossObservationStartDateKey = [...grossExpenseByDate.keys()].reduce<string | undefined>(
    (earliest, dateKey) => earliest === undefined || dateKey < earliest ? dateKey : earliest,
    undefined,
  );
  const windowStartCandidate = addLocalDays(yesterdayDateKey, -29);
  const statisticsStartDateKey = prepared.earliestCompletedEntryDateKey === undefined
    ? undefined
    : prepared.earliestCompletedEntryDateKey > windowStartCandidate
      ? prepared.earliestCompletedEntryDateKey
      : windowStartCandidate;
  const statisticsDayCount = statisticsStartDateKey === undefined
    ? 0
    : localCalendarDayDifference(statisticsStartDateKey, yesterdayDateKey) + 1;
  const statisticsTotalExpenseMinor = statisticsStartDateKey === undefined
    ? 0
    : expenseInRange(prepared.expenseByDate, statisticsStartDateKey, yesterdayDateKey);
  const confidence: ForecastConfidence = statisticsDayCount < MINIMUM_FORECAST_DAYS
    ? "insufficient"
    : statisticsDayCount < READY_FORECAST_DAYS
      ? "preliminary"
      : "ready";
  const averageDailyExpenseMinor = statisticsDayCount > 0
    ? scaledExpense(statisticsTotalExpenseMinor, 1, statisticsDayCount)
    : undefined;
  const statisticsWindow = {
    ...(statisticsStartDateKey ? { startDateKey: statisticsStartDateKey } : {}),
    endDateKey: yesterdayDateKey,
    observedDays: statisticsDayCount,
    daysNeeded: MINIMUM_FORECAST_DAYS,
    totalExpenseMinor: statisticsTotalExpenseMinor,
    ...(averageDailyExpenseMinor !== undefined ? { averageDailyExpenseMinor } : {}),
  };

  const configuredUpcomingPaydayDateKey = resolveNextPaydayDateKey(plan.paydayDay, now);
  const overriddenTargetPaydayDateKey = incomeForecast !== undefined &&
    incomeForecast.targetPaydayDateKey >= todayDateKey
    ? incomeForecast.targetPaydayDateKey
    : undefined;
  const currentRange = overriddenTargetPaydayDateKey
    ? (() => {
      const targetRegularRange = resolvePayCycleRange(
        plan.paydayDay,
        localDateFromKey(overriddenTargetPaydayDateKey),
      );
      const previousRegularRange = resolvePayCycleRange(
        plan.paydayDay,
        localDateFromKey(addLocalDays(targetRegularRange.cycleStartDateKey, -1)),
      );
      return {
        cycleStartDateKey: previousRegularRange.cycleStartDateKey,
        cycleEndDateKey: addLocalDays(overriddenTargetPaydayDateKey, -1),
        nextPaydayDateKey: overriddenTargetPaydayDateKey,
        daysUntilPayday: Math.max(
          0,
          localCalendarDayDifference(todayDateKey, overriddenTargetPaydayDateKey),
        ),
      };
    })()
    : hasSavingsInput
      ? currentCycleRangeFromSettlements(plan, now, todayDateKey, savingsEvents)
      : resolvePayCycleRange(plan.paydayDay, now);
  const currentActualExpenseMinor = expenseInRange(
    grossExpenseByDate,
    currentRange.cycleStartDateKey,
    todayDateKey,
  );
  const legacyAnalysisTargetMinor = savingsTargetFromPlan(plan);
  const currentRetainedSavings = hasSavingsInput
    ? calculateRetainedSavingsSummary(
      savingsEvents.filter((event) => event.localDateKey <= todayDateKey),
    )
    : undefined;
  const currentSavings = hasSavingsInput
    ? calculateCycleSavingsProgress(
      savingsEvents,
      plan,
      currentRange.cycleStartDateKey,
      currentRange.cycleEndDateKey,
      currentRange.nextPaydayDateKey,
      todayDateKey,
      effectiveTargetOverride,
    )
    : undefined;
  const rawSpendableMinor = currentSavings && currentRetainedSavings
    ? calculateSpendableBalanceMinor(balanceMinor, currentRetainedSavings)
    : BigInt(balanceMinor) - BigInt(legacyAnalysisTargetMinor);
  const currentBalanceHeadroomMinor = rawSpendableMinor;
  const currentSafeToSpendMinor = currentBalanceHeadroomMinor > 0n
    ? currentBalanceHeadroomMinor
    : 0n;
  const forecastDayCount = Math.max(1, currentRange.daysUntilPayday);
  const dailySafeToSpendMinor = currentSafeToSpendMinor / BigInt(forecastDayCount);

  const forecastIsAvailable = confidence !== "insufficient" && statisticsDayCount > 0;
  const estimatedRemainingExpenseMinor = forecastIsAvailable
    ? scaledExpense(
      statisticsTotalExpenseMinor,
      forecastDayCount,
      statisticsDayCount,
    )
    : undefined;
  const projectedEndBalanceMinor = estimatedRemainingExpenseMinor === undefined
    ? undefined
    : BigInt(balanceMinor) - BigInt(estimatedRemainingExpenseMinor);
  const balanceGoalDifferenceMinor = projectedEndBalanceMinor === undefined
    ? undefined
    : currentSavings && currentRetainedSavings
      ? projectedEndBalanceMinor
        - currentRetainedSavings.totalRetainedMinor
      : projectedEndBalanceMinor - BigInt(legacyAnalysisTargetMinor);

  const upcomingPaydayDateKey = incomeForecast?.targetPaydayDateKey
    ?? configuredUpcomingPaydayDateKey;
  const followingForecastPaydayDateKey = incomeForecast
    ? resolveFollowingPaydayDateKey(
      plan.paydayDay,
      localDateFromKey(incomeForecast.targetPaydayDateKey),
    )
    : undefined;
  const nextRange = incomeForecast && followingForecastPaydayDateKey
    ? {
      cycleStartDateKey: incomeForecast.targetPaydayDateKey,
      cycleEndDateKey: addLocalDays(followingForecastPaydayDateKey, -1),
      nextPaydayDateKey: followingForecastPaydayDateKey,
    }
    : resolvePayCycleRange(
      plan.paydayDay,
      localDateFromKey(upcomingPaydayDateKey),
    );
  const nextCycleDayCount = localCalendarDayDifference(
    nextRange.cycleStartDateKey,
    nextRange.nextPaydayDateKey,
  );
  const referenceSpendMinor = forecastIsAvailable
    ? scaledExpense(statisticsTotalExpenseMinor, nextCycleDayCount, statisticsDayCount)
    : undefined;
  const incomeForecastIsUpcoming = incomeForecast !== undefined &&
    incomeForecast.targetPaydayDateKey >= todayDateKey;

  let excludedExpenseMinor = 0;
  let periodicExpenseMinor = 0;
  let oneTimeExpenseMinor = 0;
  let pendingReimbursementMinor = 0;
  let pendingConfirmationCount = 0;
  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (entry.deletedAt) continue;
    if (entry.confirmationStatus === "pending") pendingConfirmationCount += 1;
    if (entry.localDateKey > todayDateKey) continue;
    if (statisticsStartDateKey && entry.localDateKey < statisticsStartDateKey) continue;
    if (entry.localDateKey > yesterdayDateKey) continue;
    if (!affectsCashflow(entry) || entry.amountMinor >= 0) continue;
    if (isDailySpendCandidate(entry)) continue;
    excludedExpenseMinor = safeAdd(excludedExpenseMinor, Math.abs(entry.amountMinor));
    if (entry.treatment === "periodic_expense") {
      periodicExpenseMinor = safeAdd(
        periodicExpenseMinor,
        netPersonalExpenseMinor(entry, allocations),
      );
    } else if (entry.treatment === "one_time_expense") {
      oneTimeExpenseMinor = safeAdd(
        oneTimeExpenseMinor,
        netPersonalExpenseMinor(entry, allocations),
      );
    } else if (entry.treatment === "reimbursable_expense") {
      pendingReimbursementMinor = safeAdd(
        pendingReimbursementMinor,
        unrecoveredExpenseMinor(entry, allocations),
      );
    }
  }

  const currentCycle: SpendingAnalysis["currentCycle"] = {
    cycleStartDateKey: currentRange.cycleStartDateKey,
    cycleEndDateKey: currentRange.cycleEndDateKey,
    nextPaydayDateKey: currentRange.nextPaydayDateKey,
    daysUntilPayday: currentRange.daysUntilPayday,
    actualExpenseMinor: currentActualExpenseMinor,
    balanceHeadroomMinor: currentBalanceHeadroomMinor,
    safeToSpendMinor: currentSafeToSpendMinor,
    dailySafeToSpendMinor,
    ...(currentSavings && currentRetainedSavings
      ? {
        totalBalanceMinor: BigInt(balanceMinor),
        retainedBalanceMinor: currentRetainedSavings.totalRetainedMinor,
        spendableBalanceMinor: rawSpendableMinor,
        savingsNeedsCorrection:
          currentSavings.needsCorrection || currentRetainedSavings.needsCorrection,
      }
      : {}),
    ...(estimatedRemainingExpenseMinor !== undefined
      ? {
        estimatedRemainingExpenseMinor,
        projectedEndBalanceMinor,
        balanceGoalDifferenceMinor,
        affordability: outcomeFromDifference(balanceGoalDifferenceMinor!),
        ...(currentSavings
          ? {
            savingsDifferenceMinor: balanceGoalDifferenceMinor,
            savingsAffordability: outcomeFromDifference(balanceGoalDifferenceMinor!),
          }
          : {}),
      }
      : {}),
  };
  const nextCycle: SpendingAnalysis["nextCycle"] = {
    cycleStartDateKey: nextRange.cycleStartDateKey,
    cycleEndDateKey: nextRange.cycleEndDateKey,
    nextPaydayDateKey: nextRange.nextPaydayDateKey,
    days: nextCycleDayCount,
    ...(referenceSpendMinor !== undefined
      ? {
        referenceSpendMinor,
        ...(incomeForecastIsUpcoming
          ? {
            expectedIncomeScenario: incomeScenario(
              incomeForecast.expectedIncomeMinor,
              referenceSpendMinor,
            ),
            ...(incomeForecast.minimumIncomeMinor !== undefined
              ? {
                minimumIncomeScenario: incomeScenario(
                  incomeForecast.minimumIncomeMinor,
                  referenceSpendMinor,
                ),
              }
              : {}),
          }
          : {}),
      }
      : {}),
  };
  const savingsHistory = hasSavingsInput
    ? calculateSavingsHistory(
      savingsEvents,
      plan,
      currentRange.cycleStartDateKey,
    )
    : undefined;
  if (savingsHistory) nextCycle.savingsHistory = savingsHistory;
  const savingsGoalProgress = cumulativeSavingsGoal && currentRetainedSavings
    ? calculateSavingsGoalProgress(
      cumulativeSavingsGoal,
      currentRetainedSavings,
      plan.paydayDay,
      now,
    )
    : undefined;

  return {
    asOfDateKey: todayDateKey,
    confidence,
    window: statisticsWindow,
    includedExpenseMinor: statisticsTotalExpenseMinor,
    excludedExpenseMinor,
    periodicExpenseMinor,
    oneTimeExpenseMinor,
    pendingReimbursementMinor,
    pendingConfirmationCount,
    ...(plan.cycleEndBalanceGoalMinor !== undefined
      ? { cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor }
      : {}),
    ...(hasSavingsInput
      ? {
        retainedSavings: currentRetainedSavings!,
        ...(savingsHistory ? { savingsHistory } : {}),
        ...(savingsGoalProgress ? { savingsGoal: savingsGoalProgress } : {}),
      }
      : {}),
    currentCycle,
    nextCycle,
    // Daily chart uses the baseline window (ordinary net amounts).
    dailyExpenses: buildDailyExpenses(
      prepared.expenseByDate,
      statisticsStartDateKey,
      yesterdayDateKey,
    ),
    // Current-cycle series: actuals are gross external outflows; projection
    // adds remaining daily-spend baseline only.
    currentCycleSeries: currentCycleSpendingSeries(
      grossExpenseByDate,
      currentRange.cycleStartDateKey,
      todayDateKey,
      currentRange.nextPaydayDateKey,
      estimatedRemainingExpenseMinor,
    ),
    completedCycles: completedPayCycles(
      grossExpenseByDate,
      plan.paydayDay,
      currentRange.cycleStartDateKey,
      grossObservationStartDateKey,
      hasSavingsInput ? savingsEvents : [],
    ),
  };
}
