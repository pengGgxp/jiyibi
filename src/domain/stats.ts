import { currentLocalMonthKey } from "./date";
import type {
  AppSettings,
  LedgerEntry,
  LedgerSummary,
  MonthEndBalanceGoalStatus,
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

export function calculateMonthEndBalanceGoalStatus(
  balanceMinor: number,
  targetMinor: number,
  now = new Date(),
): MonthEndBalanceGoalStatus {
  if (!Number.isSafeInteger(balanceMinor) || !Number.isSafeInteger(targetMinor)) {
    throw new RangeError("余额目标必须使用整数分");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("目标周期日期无效");
  }

  const differenceMinor = BigInt(balanceMinor) - BigInt(targetMinor);
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    targetMinor,
    differenceMinor,
    isOnTrack: differenceMinor >= 0n,
    daysRemaining: lastDayOfMonth - now.getDate(),
    localMonthKey: currentLocalMonthKey(now),
  };
}
