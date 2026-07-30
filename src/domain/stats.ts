import type { AppSettings, LedgerEntry, LedgerSummary } from "./types";

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
