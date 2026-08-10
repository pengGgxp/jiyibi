import {
  addLocalDays,
  currentLocalDateKey,
  localCalendarDayDifference,
  localDateFromKey,
  resolvePayCycleRange,
} from "./date";
import type {
  AppSettings,
  CompletedPayCyclePoint,
  CurrentCycleSpendingPoint,
  DailyExpensePoint,
  ForecastConfidence,
  ForecastOutcome,
  LedgerEntry,
  LedgerSummary,
  PayCyclePlan,
  PayCycleStatus,
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
    !Number.isSafeInteger(plan.monthlySalaryMinor) ||
    plan.monthlySalaryMinor <= 0 ||
    !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
  ) {
    throw new RangeError("分析金额和工资周期必须使用有效的整数分");
  }
}

interface AnalysisEntries {
  expenseByDate: Map<string, number>;
  earliestCompletedEntryDateKey?: string;
}

function prepareAnalysisEntries(
  entries: readonly LedgerEntry[],
  todayDateKey: string,
  yesterdayDateKey: string,
): AnalysisEntries {
  const expenseByDate = new Map<string, number>();
  let earliestCompletedEntryDateKey: string | undefined;

  for (const entry of entries) {
    if (entry.deletedAt) continue;
    // Parsing also prevents lexicographic comparisons from accepting malformed keys.
    localDateFromKey(entry.localDateKey);
    if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
      throw new RangeError("账目金额必须使用非零整数分");
    }
    if (entry.localDateKey > todayDateKey) continue;

    if (entry.localDateKey <= yesterdayDateKey) {
      earliestCompletedEntryDateKey = earliestCompletedEntryDateKey === undefined
        || entry.localDateKey < earliestCompletedEntryDateKey
        ? entry.localDateKey
        : earliestCompletedEntryDateKey;
    }
    if (entry.amountMinor > 0) continue;

    const expenseMinor = Math.abs(entry.amountMinor);
    expenseByDate.set(
      entry.localDateKey,
      safeAdd(expenseByDate.get(entry.localDateKey) ?? 0, expenseMinor),
    );
  }

  return { expenseByDate, earliestCompletedEntryDateKey };
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

  for (const entry of entries) {
    if (entry.deletedAt) continue;
    balanceMinor = safeAdd(balanceMinor, entry.amountMinor);
    if (entry.localMonthKey !== monthKey) continue;
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
    !Number.isSafeInteger(plan.monthlySalaryMinor) ||
    plan.monthlySalaryMinor <= 0 ||
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
    !Number.isSafeInteger(plan.monthlySalaryMinor) ||
    plan.monthlySalaryMinor <= 0 ||
    !Number.isSafeInteger(plan.cycleEndBalanceGoalMinor)
  ) {
    throw new RangeError("工资周期金额必须使用整数分");
  }
  const range = resolvePayCycleRange(plan.paydayDay, now);
  let cycleExpenseMinor = 0;
  let cycleIncomeMinor = 0;
  for (const entry of entries) {
    if (
      entry.deletedAt ||
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
  const salaryRemainingMinor = BigInt(plan.monthlySalaryMinor) - BigInt(cycleExpenseMinor);
  const availableMinor = salaryRemainingMinor < balanceHeadroomMinor
    ? salaryRemainingMinor
    : balanceHeadroomMinor;
  const rawSpentPercent = BigInt(cycleExpenseMinor) * 100n / BigInt(plan.monthlySalaryMinor);
  return {
    ...plan,
    targetMinor,
    balanceHeadroomMinor,
    isCurrentlyAtOrAboveGoal: balanceHeadroomMinor >= 0n,
    cycleExpenseMinor,
    cycleIncomeMinor,
    salaryRemainingMinor,
    safeToSpendMinor: availableMinor > 0n ? availableMinor : 0n,
    salarySpentPercent: Number(rawSpentPercent > 999n ? 999n : rawSpentPercent),
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
  now = new Date(),
): SpendingAnalysis {
  assertAnalysisInputs(balanceMinor, plan);
  if (!Number.isFinite(now.getTime())) throw new RangeError("分析日期无效");

  const todayDateKey = currentLocalDateKey(now);
  const yesterdayDateKey = addLocalDays(todayDateKey, -1);
  const prepared = prepareAnalysisEntries(entries, todayDateKey, yesterdayDateKey);
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
    prepared.expenseByDate,
    currentRange.cycleStartDateKey,
    todayDateKey,
  );
  const currentBalanceHeadroomMinor = BigInt(balanceMinor) - BigInt(plan.cycleEndBalanceGoalMinor);
  const currentSalaryRemainingMinor = BigInt(plan.monthlySalaryMinor)
    - BigInt(currentActualExpenseMinor);
  const currentAvailableMinor = currentSalaryRemainingMinor < currentBalanceHeadroomMinor
    ? currentSalaryRemainingMinor
    : currentBalanceHeadroomMinor;
  const currentSafeToSpendMinor = currentAvailableMinor > 0n ? currentAvailableMinor : 0n;
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

  const nextRange = resolvePayCycleRange(
    plan.paydayDay,
    localDateFromKey(currentRange.nextPaydayDateKey),
  );
  const nextCycleDayCount = localCalendarDayDifference(
    nextRange.cycleStartDateKey,
    nextRange.nextPaydayDateKey,
  );
  const estimatedNextExpenseMinor = forecastIsAvailable
    ? scaledExpense(statisticsTotalExpenseMinor, nextCycleDayCount, statisticsDayCount)
    : undefined;
  const salaryDifferenceMinor = estimatedNextExpenseMinor === undefined
    ? undefined
    : BigInt(plan.monthlySalaryMinor) - BigInt(estimatedNextExpenseMinor);

  const currentCycle: SpendingAnalysis["currentCycle"] = {
    cycleStartDateKey: currentRange.cycleStartDateKey,
    cycleEndDateKey: currentRange.cycleEndDateKey,
    nextPaydayDateKey: currentRange.nextPaydayDateKey,
    daysUntilPayday: currentRange.daysUntilPayday,
    actualExpenseMinor: currentActualExpenseMinor,
    balanceHeadroomMinor: currentBalanceHeadroomMinor,
    salaryRemainingMinor: currentSalaryRemainingMinor,
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
    ...(estimatedNextExpenseMinor !== undefined
      ? {
        estimatedExpenseMinor: estimatedNextExpenseMinor,
        salaryDifferenceMinor,
        affordability: outcomeFromDifference(salaryDifferenceMinor!),
      }
      : {}),
  };

  return {
    asOfDateKey: todayDateKey,
    confidence,
    window: statisticsWindow,
    salaryReferenceMinor: plan.monthlySalaryMinor,
    cycleEndBalanceGoalMinor: plan.cycleEndBalanceGoalMinor,
    currentCycle,
    nextCycle,
    dailyExpenses: buildDailyExpenses(
      prepared.expenseByDate,
      statisticsStartDateKey,
      yesterdayDateKey,
    ),
    currentCycleSeries: currentCycleSpendingSeries(
      prepared.expenseByDate,
      currentRange.cycleStartDateKey,
      todayDateKey,
      currentRange.nextPaydayDateKey,
      estimatedRemainingExpenseMinor,
    ),
    completedCycles: completedPayCycles(
      prepared.expenseByDate,
      plan.paydayDay,
      currentRange.cycleStartDateKey,
      prepared.earliestCompletedEntryDateKey,
    ),
  };
}
