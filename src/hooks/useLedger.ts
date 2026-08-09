import { liveQuery } from "dexie";
import { useEffect, useMemo, useState } from "react";
import { getSettings, listActiveEntries } from "../data";
import {
  calculateLedgerSummary,
  currentLocalDateKey,
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
  const [localDateKey, setLocalDateKey] = useState(() => currentLocalDateKey());

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
    );
  }, [localDateKey, snapshot]);

  return {
    entries: snapshot?.entries ?? [],
    settings: snapshot?.settings,
    summary,
    loading: !snapshot && !error,
    error,
  };
}
