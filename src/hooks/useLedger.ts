import { liveQuery } from "dexie";
import { useEffect, useMemo, useState } from "react";
import { getSettings, listActiveEntries } from "../data";
import {
  calculateLedgerSummary,
  currentLocalMonthKey,
  type AppSettings,
  type LedgerEntry,
  type LedgerSummary,
} from "../domain";

interface LedgerSnapshot {
  entries: LedgerEntry[];
  settings: AppSettings;
}

export interface LedgerState {
  entries: LedgerEntry[];
  settings?: AppSettings;
  summary?: LedgerSummary;
  loading: boolean;
  error?: Error;
}

export function useLedger(): LedgerState {
  const [snapshot, setSnapshot] = useState<LedgerSnapshot>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    const subscription = liveQuery(async () => {
      const [entries, settings] = await Promise.all([listActiveEntries(), getSettings()]);
      return { entries, settings };
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

  const summary = useMemo(() => {
    if (!snapshot) return undefined;
    return calculateLedgerSummary(
      snapshot.entries,
      snapshot.settings,
      currentLocalMonthKey(),
    );
  }, [snapshot]);

  return {
    entries: snapshot?.entries ?? [],
    settings: snapshot?.settings,
    summary,
    loading: !snapshot && !error,
    error,
  };
}
