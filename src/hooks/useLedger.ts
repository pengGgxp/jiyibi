import { liveQuery } from "dexie";
import { useEffect, useMemo, useState } from "react";
import {
  getSettings,
  listActiveEntries,
  listBalanceAdjustments,
  listActiveRecoveryAllocations,
  listActiveSavingsEvents,
} from "../data";
import {
  calculateLedgerSummary,
  calculatePayCycleStatus,
  calculateSpendingAnalysis,
  currentLocalDateKey,
  payCyclePlanFromSettings,
  type AppSettings,
  type BalanceAdjustment,
  type LedgerEntry,
  type LedgerSummary,
  type PayCycleStatus,
  type RecoveryAllocation,
  type SavingsEvent,
  type SpendingAnalysis,
} from "../domain";

interface LedgerSnapshot {
  entries: LedgerEntry[];
  settings: AppSettings;
  allocations: RecoveryAllocation[];
  savingsEvents: SavingsEvent[];
  balanceAdjustments: BalanceAdjustment[];
}

export interface LedgerState {
  entries: LedgerEntry[];
  settings?: AppSettings;
  summary?: LedgerSummary;
  payCycleStatus?: PayCycleStatus;
  analysis?: SpendingAnalysis;
  savingsEvents: SavingsEvent[];
  balanceAdjustments: BalanceAdjustment[];
  recoveryAllocations: RecoveryAllocation[];
  analysisError?: Error;
  loading: boolean;
  error?: Error;
}

export function useLedger(): LedgerState {
  const [snapshot, setSnapshot] = useState<LedgerSnapshot>();
  const [error, setError] = useState<Error>();
  const [localDateKey, setLocalDateKey] = useState(() => currentLocalDateKey());

  useEffect(() => {
    const subscription = liveQuery(async () => {
      const [entries, settings, allocations, savingsEvents, balanceAdjustments] = await Promise.all([
        listActiveEntries(),
        getSettings(),
        listActiveRecoveryAllocations(),
        listActiveSavingsEvents(),
        listBalanceAdjustments(),
      ]);
      return { entries, settings, allocations, savingsEvents, balanceAdjustments };
    }).subscribe({
      next: (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setError(undefined);
      },
      error: (reason: unknown) => {
        setError(reason instanceof Error ? reason : new Error("无法读取本机账目"));
      },
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let midnightTimer: number | undefined;
    const refreshDate = () => setLocalDateKey(currentLocalDateKey());
    const scheduleMidnightRefresh = () => {
      window.clearTimeout(midnightTimer);
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        1_000,
      );
      midnightTimer = window.setTimeout(() => {
        refreshDate();
        scheduleMidnightRefresh();
      }, nextMidnight.getTime() - now.getTime());
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshDate();
        scheduleMidnightRefresh();
      }
    };

    scheduleMidnightRefresh();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(midnightTimer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const summary = useMemo(() => {
    if (!snapshot) return undefined;
    return calculateLedgerSummary(
      snapshot.entries,
      snapshot.settings,
      localDateKey.slice(0, 7),
      snapshot.balanceAdjustments,
    );
  }, [localDateKey, snapshot]);

  const payCycleStatus = useMemo(() => {
    if (!snapshot || !summary) return undefined;
    const plan = payCyclePlanFromSettings(snapshot.settings);
    const [year, month, day] = localDateKey.split("-").map(Number);
    const localToday = new Date(year, month - 1, day, 12);
    return plan
      ? calculatePayCycleStatus(snapshot.entries, summary.balanceMinor, plan, localToday)
      : undefined;
  }, [localDateKey, snapshot, summary]);

  const analysisResult = useMemo(() => {
    if (!snapshot || !summary) return {};
    const plan = payCyclePlanFromSettings(snapshot.settings);
    if (!plan) return {};
    const [year, month, day] = localDateKey.split("-").map(Number);
    try {
      return {
        analysis: calculateSpendingAnalysis(
          snapshot.entries,
          summary.balanceMinor,
          plan,
          snapshot.settings.incomeForecast,
          new Date(year, month - 1, day, 12),
          snapshot.allocations,
          {
            savingsEvents: snapshot.savingsEvents,
            savingsGoal: snapshot.settings.savingsGoal,
          },
        ),
      };
    } catch (reason) {
      return {
        analysisError: reason instanceof Error
          ? reason
          : new Error("无法计算消费分析"),
      };
    }
  }, [localDateKey, snapshot, summary]);

  return {
    entries: snapshot?.entries ?? [],
    savingsEvents: snapshot?.savingsEvents ?? [],
    balanceAdjustments: snapshot?.balanceAdjustments ?? [],
    recoveryAllocations: snapshot?.allocations ?? [],
    settings: snapshot?.settings,
    summary,
    payCycleStatus,
    ...analysisResult,
    loading: !snapshot && !error,
    error,
  };
}
