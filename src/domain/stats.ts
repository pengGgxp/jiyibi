import {
  addLocalDays,
  currentLocalDateKey,
  localCalendarDayDifference,
  localDateFromKey,
  resolveNextPaydayDateKey,
  resolvePayCycleRange,
} from "./date";
import {
  affectsBookBalance,
  affectsCashflow,
  isDailySpendCandidate,
  normalizeLedgerEntry,
  ordinaryExpenseNetAnalysisMinor,
} from "./entry-treatment";
import type {
  AppSettings,
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
  SpendingAnalysis,
} from "./types";

const MINIMUM_FORECAST_DAYS = 14;
const READY_FORECAST_DAYS = 30;
const COMPLETED_CYCLE_COUNT = 6;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

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
    plan.paydayDay > 31 ||
    !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
  ) {
    throw new RangeError("分析金额和工资周期必须使用有效的整数分");
  }
}

function assertIncomeForecast(forecast: IncomeForecast): void {
  localDateFromKey(forecast.targetPaydayDateKey);
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
): IncomeScenarioAnalysis {
  const differenceMinor = BigInt(incomeMinor) - BigInt(referenceSpendMinor);
  return {
    incomeMinor,
    differenceMinor,
    affordability: outcomeFromDifference(differenceMinor),
  };
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

function completedPayCycles(
  expenseByDate: ReadonlyMap<string, number>,
  paydayDay: number,
  currentCycleStartDateKey: string,
  observationStartDateKey: string | undefined,
): CompletedPayCyclePoint[] {
  const cycles: CompletedPayCyclePoint[] = [];
  let cursorDateKey = addLocalDays(currentCycleStartDateKey, -1);
  for (let index = 0; index < COMPLETED_CYCLE_COUNT; index += 1) {
    const range = resolvePayCycleRange(paydayDay, localDateFromKey(cursorDateKey));
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
): LedgerSummary {
  let balanceMinor = settings.initialBalanceMinor;
  let monthIncomeMinor = 0;
  let monthExpenseMinor = 0;

  for (const raw of entries) {
    const entry = normalizeLedgerEntry(raw);
    if (entry.deletedAt) continue;
    if (affectsBookBalance(entry)) {
      balanceMinor = safeAdd(balanceMinor, entry.amountMinor);
    }
    if (entry.localMonthKey !== monthKey) continue;
    if (!affectsCashflow(entry)) continue;
    if (entry.amountMinor > 0) {
      monthIncomeMinor = safeAdd(monthIncomeMinor, entry.amountMinor);
    } else {
      monthExpenseMinor = safeAdd(monthExpenseMinor, Math.abs(entry.amountMinor));
    }
  }

  return { balanceMinor, monthIncomeMinor, monthExpenseMinor };
}

export function payCyclePlanFromSettings(
  settings: AppSettings | undefined,
): PayCyclePlan | undefined {
  const plan = settings?.payCycle;
  if (
    !plan ||
    !Number.isInteger(plan.paydayDay) ||
    plan.paydayDay < 1 ||
    plan.paydayDay > 31 ||
    !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
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
  if (
    !Number.isSafeInteger(balanceMinor) ||
    !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
  ) {
    throw new RangeError("工资周期金额必须使用整数分");
  }
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

  const targetMinor = plan.cycleEndBalanceGoalMinor;
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
): SpendingAnalysis {
  assertAnalysisInputs(balanceMinor, plan);
  if (incomeForecast) assertIncomeForecast(incomeForecast);
  if (!Number.isFinite(now.getTime())) throw new RangeError("分析日期无效");

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

  const currentRange = resolvePayCycleRange(plan.paydayDay, now);
  const currentActualExpenseMinor = expenseInRange(
    grossExpenseByDate,
    currentRange.cycleStartDateKey,
    todayDateKey,
  );
  const currentBalanceHeadroomMinor = BigInt(balanceMinor) - BigInt(plan.cycleEndBalanceGoalMinor);
  const currentSafeToSpendMinor = currentBalanceHeadroomMinor > 0n
    ? currentBalanceHeadroomMinor
    : 0n;
  const dailySafeToSpendMinor = currentSafeToSpendMinor / BigInt(currentRange.daysUntilPayday);

  const forecastIsAvailable = confidence !== "insufficient" && statisticsDayCount > 0;
  const estimatedRemainingExpenseMinor = forecastIsAvailable
    ? scaledExpense(
      statisticsTotalExpenseMinor,
      currentRange.daysUntilPayday,
      statisticsDayCount,
    )
    : undefined;
  const projectedEndBalanceMinor = estimatedRemainingExpenseMinor === undefined
    ? undefined
    : BigInt(balanceMinor) - BigInt(estimatedRemainingExpenseMinor);
  const balanceGoalDifferenceMinor = projectedEndBalanceMinor === undefined
    ? undefined
    : projectedEndBalanceMinor - BigInt(plan.cycleEndBalanceGoalMinor);

  const upcomingPaydayDateKey = resolveNextPaydayDateKey(plan.paydayDay, now);
  const nextRange = resolvePayCycleRange(
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
  const incomeForecastIsUpcoming = incomeForecast?.targetPaydayDateKey === upcomingPaydayDateKey;

  const currentCycle: SpendingAnalysis["currentCycle"] = {
    cycleStartDateKey: currentRange.cycleStartDateKey,
    cycleEndDateKey: currentRange.cycleEndDateKey,
    nextPaydayDateKey: currentRange.nextPaydayDateKey,
    daysUntilPayday: currentRange.daysUntilPayday,
    actualExpenseMinor: currentActualExpenseMinor,
    balanceHeadroomMinor: currentBalanceHeadroomMinor,
    safeToSpendMinor: currentSafeToSpendMinor,
    dailySafeToSpendMinor,
    ...(estimatedRemainingExpenseMinor !== undefined
      ? {
        estimatedRemainingExpenseMinor,
        projectedEndBalanceMinor,
        balanceGoalDifferenceMinor,
        affordability: outcomeFromDifference(balanceGoalDifferenceMinor!),
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
            minimumIncomeScenario: incomeScenario(
              incomeForecast.minimumIncomeMinor,
              referenceSpendMinor,
            ),
            expectedIncomeScenario: incomeScenario(
              incomeForecast.expectedIncomeMinor,
              referenceSpendMinor,
            ),
          }
          : {}),
      }
      : {}),
  };

  return {
    asOfDateKey: todayDateKey,
    confidence,
    window: statisticsWindow,
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
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
      prepared.earliestCompletedEntryDateKey,
    ),
  };
}
