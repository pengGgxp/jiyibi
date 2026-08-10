import { resolvePayCycleRange } from "./date";
import type {
  AppSettings,
  LedgerEntry,
  LedgerSummary,
  PayCyclePlan,
  PayCycleStatus,
} from "./types";

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError("账目合计超出安全范围");
  }
  return result;
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
