import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "jiyibi:pending-dismissals";

function localStorageOrUndefined(): Storage | undefined {
  try {
    const storage = globalThis.localStorage;
    return typeof storage?.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : undefined;
  } catch {
    return undefined;
  }
}

function readDismissals(): Record<string, string> {
  try {
    const raw = localStorageOrUndefined()?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      ([key, value]) => key.length <= 256 && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
    ));
  } catch {
    return {};
  }
}

export function usePendingDismissals(todayDateKey: string) {
  const [dismissals, setDismissals] = useState<Record<string, string>>(readDismissals);

  useEffect(() => {
    setDismissals((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([, dateKey]) => dateKey === todayDateKey),
      );
      try {
        localStorageOrUndefined()?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Dismissal is a convenience; storage failure must not block the ledger.
      }
      return next;
    });
  }, [todayDateKey]);

  const snooze = useCallback((id: string) => {
    setDismissals((current) => {
      const next = { ...current, [id]: todayDateKey };
      try {
        localStorageOrUndefined()?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep the in-memory dismissal for this session.
      }
      return next;
    });
  }, [todayDateKey]);

  return useMemo(() => ({ dismissals, snooze }), [dismissals, snooze]);
}
