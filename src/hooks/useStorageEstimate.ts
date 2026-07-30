import { useCallback, useEffect, useState } from "react";
import { estimateLocalStorage, type StorageEstimate } from "../lib/storage";

export function useStorageEstimate(active: boolean) {
  const [estimate, setEstimate] = useState<StorageEstimate>();
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setEstimate(await estimateLocalStorage());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  return { estimate, error, refresh };
}
