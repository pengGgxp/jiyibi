import { useCallback, useEffect, useState } from "react";
import {
  estimateLocalStorage,
  persistentStorageStatus,
  requestPersistentStorage,
  type StorageEstimate,
} from "../lib/storage";

export function useStorageEstimate(active: boolean) {
  const [estimate, setEstimate] = useState<StorageEstimate>();
  const [error, setError] = useState(false);
  const [persistent, setPersistent] = useState<boolean>();

  const refresh = useCallback(async () => {
    try {
      const [nextEstimate, nextPersistent] = await Promise.all([
        estimateLocalStorage(),
        persistentStorageStatus(),
      ]);
      setEstimate(nextEstimate);
      setPersistent(nextPersistent);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const requestPersistence = useCallback(async () => {
    const granted = await requestPersistentStorage();
    setPersistent(granted);
    return granted;
  }, []);

  return { estimate, persistent, error, refresh, requestPersistence };
}
