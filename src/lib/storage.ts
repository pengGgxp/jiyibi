export interface StorageEstimate {
  usage: number;
  quota: number;
  available: number;
  supported: boolean;
}

export async function estimateLocalStorage(): Promise<StorageEstimate> {
  if (!navigator.storage?.estimate) {
    return { usage: 0, quota: 0, available: 0, supported: false };
  }
  const estimate = await navigator.storage.estimate();
  const usage = estimate.usage ?? 0;
  const quota = estimate.quota ?? 0;
  return {
    usage,
    quota,
    available: Math.max(0, quota - usage),
    supported: true,
  };
}
