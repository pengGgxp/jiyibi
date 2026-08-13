import {
  CURRENT_DETECTION_RULE_VERSION,
  type EntryTreatment,
  type LedgerEntry,
  type SpendingAnalysis,
} from "./types";
import { normalizeLedgerEntry } from "./entry-treatment";

/** Calibrated high-signal thresholds for synthetic representative ledgers. */
export const EXCEPTION_SHARE_OF_WINDOW = 0.25;
export const EXCEPTION_DAILY_MULTIPLIER = 5;
export const EXCEPTION_ABSOLUTE_MINOR = 50_000;
export const REFUND_MATCH_TOLERANCE_MINOR = 100;
export const REFUND_LOOKBACK_DAYS = 60;

export type ExceptionPromptKind = "expense" | "income";

export interface ExceptionPromptDecision {
  shouldPrompt: boolean;
  kind: ExceptionPromptKind;
  reasons: string[];
  detectionRuleVersion: number;
}

function absMinor(entry: LedgerEntry): number {
  return Math.abs(entry.amountMinor);
}

function sameRevisionAlreadyPrompted(entry: LedgerEntry): boolean {
  return entry.promptedRevision === entry.updatedAt
    && (entry.confirmationStatus === "pending" || entry.confirmationStatus === "confirmed");
}

/**
 * High-signal check after a successful save. Conservative defaults:
 * large share of recent baseline, large absolute amount, or near-match refund candidate.
 * Never auto-classifies treatment.
 */
export function evaluateExceptionPrompt(
  entry: LedgerEntry,
  allEntries: readonly LedgerEntry[],
  analysis: SpendingAnalysis | undefined,
): ExceptionPromptDecision {
  const normalized = normalizeLedgerEntry(entry);
  const kind: ExceptionPromptKind = normalized.amountMinor < 0 ? "expense" : "income";
  const reasons: string[] = [];

  if (normalized.deletedAt) {
    return {
      shouldPrompt: false,
      kind,
      reasons,
      detectionRuleVersion: CURRENT_DETECTION_RULE_VERSION,
    };
  }
  if (normalized.confirmationStatus === "confirmed") {
    return {
      shouldPrompt: false,
      kind,
      reasons,
      detectionRuleVersion: CURRENT_DETECTION_RULE_VERSION,
    };
  }
  if (sameRevisionAlreadyPrompted(normalized)) {
    return {
      shouldPrompt: false,
      kind,
      reasons,
      detectionRuleVersion: CURRENT_DETECTION_RULE_VERSION,
    };
  }
  // Only prompt default ordinary rows; user-set treatments are already intentional.
  if (
    normalized.treatment !== "ordinary_expense"
    && normalized.treatment !== "ordinary_income"
  ) {
    return {
      shouldPrompt: false,
      kind,
      reasons,
      detectionRuleVersion: CURRENT_DETECTION_RULE_VERSION,
    };
  }

  const amount = absMinor(normalized);

  if (kind === "expense") {
    const windowTotal = analysis?.window.totalExpenseMinor ?? 0;
    const average = analysis?.window.averageDailyExpenseMinor ?? 0;
    const shareThreshold = windowTotal > 0
      ? Math.floor(windowTotal * EXCEPTION_SHARE_OF_WINDOW)
      : 0;
    const dailyThreshold = average > 0
      ? average * EXCEPTION_DAILY_MULTIPLIER
      : 0;
    const threshold = Math.max(
      shareThreshold,
      dailyThreshold,
      EXCEPTION_ABSOLUTE_MINOR,
    );
    if (amount >= threshold) {
      reasons.push("large_expense");
    }

    if (
      analysis?.currentCycle.affordability
      && analysis.window.observedDays >= analysis.window.daysNeeded
      && analysis.window.totalExpenseMinor > 0
    ) {
      // Rough flip check: drop this expense from the window total and re-scale remaining.
      const adjustedTotal = Math.max(0, analysis.window.totalExpenseMinor - amount);
      if (adjustedTotal < analysis.window.totalExpenseMinor) {
        const scale = analysis.currentCycle.estimatedRemainingExpenseMinor;
        if (scale !== undefined && analysis.window.observedDays > 0) {
          // If removing this expense would cut remaining spend enough to cross the goal, prompt.
          const reduction = scale - Math.floor(
            (scale * adjustedTotal) / analysis.window.totalExpenseMinor,
          );
          const diff = analysis.currentCycle.balanceGoalDifferenceMinor;
          if (
            diff !== undefined
            && analysis.currentCycle.affordability === "shortfall"
            && diff + BigInt(reduction) >= 0n
          ) {
            reasons.push("flips_affordability");
          }
        }
      }
    }
  } else {
    // Income: possible refund/reimbursement when magnitude matches a recent expense.
    const entryTime = Date.parse(normalized.occurredAt);
    const lookbackMs = REFUND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const match = allEntries.some((candidate) => {
      const other = normalizeLedgerEntry(candidate);
      if (other.id === normalized.id || other.deletedAt) return false;
      if (other.amountMinor >= 0) return false;
      const otherTime = Date.parse(other.occurredAt);
      if (!Number.isFinite(entryTime) || !Number.isFinite(otherTime)) return false;
      if (otherTime > entryTime || entryTime - otherTime > lookbackMs) return false;
      return Math.abs(absMinor(other) - amount) <= REFUND_MATCH_TOLERANCE_MINOR;
    });
    if (match) reasons.push("possible_refund");
    if (amount >= EXCEPTION_ABSOLUTE_MINOR) reasons.push("large_income");
  }

  return {
    shouldPrompt: reasons.length > 0,
    kind,
    reasons,
    detectionRuleVersion: CURRENT_DETECTION_RULE_VERSION,
  };
}

export function expenseTreatmentOptions(): Array<{
  value: EntryTreatment;
  label: string;
  detail: string;
}> {
  return [
    {
      value: "ordinary_expense",
      label: "日常支出",
      detail: "计入日常花法，用来估算以后够不够花。",
    },
    {
      value: "one_time_expense",
      label: "仅这一次",
      detail: "影响余额和现金流，但不用来推算未来花法。",
    },
    {
      value: "reimbursable_expense",
      label: "之后会报销",
      detail: "先减少当前余额；报销到账前不计入日常花法。",
    },
    {
      value: "account_transfer",
      label: "自己的账户间转账",
      detail: "确认后不改变全部个人可用资金，也不进现金流。",
    },
  ];
}

export function incomeTreatmentOptions(): Array<{
  value: EntryTreatment;
  label: string;
  detail: string;
}> {
  return [
    {
      value: "ordinary_income",
      label: "收入",
      detail: "增加余额和实际流入，不会自动变成下次收入预期。",
    },
    {
      value: "refund_reimbursement",
      label: "退款或报销",
      detail: "增加余额；可在之后关联原始支出以调整日常花法。",
    },
    {
      value: "account_transfer",
      label: "自己的账户间转账",
      detail: "确认后不改变全部个人可用资金，也不进现金流。",
    },
  ];
}
