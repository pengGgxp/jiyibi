import { liveQuery } from "dexie";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CloudConflictView,
  CloudSyncPhase,
  CloudSyncSectionProps,
} from "../components/CloudSyncSection";
import {
  LedgerDataError,
  cacheRemoteAttachment,
  getAttachment as getLocalAttachment,
  getSyncOverview,
  ledgerDb,
  linkSyncAccount,
  listActiveEntries,
  resolveSyncConflict,
  unlinkSyncAccount,
  type SyncConflict,
  type SyncOverview,
} from "../data";
import {
  entryToLocalDateTimeInput,
  formatCny,
  type AppSettings,
  type Attachment,
  type LedgerEntry,
} from "../domain";
import {
  createSyncApiClient,
  SYNC_LOCAL_CHANGE_EVENT,
  SyncApiError,
  SyncGenerationChangedError,
  SyncIncompleteError,
  syncNow,
  type SessionResponse,
} from "../sync";

type SessionStatus = "checking" | "authenticated" | "signed-out" | "error";
type Operation = "idle" | "linking" | "syncing" | "deleting" | "error";

interface LocalSyncSnapshot {
  overview: SyncOverview;
  conflicts: SyncConflict[];
  entryCount: number;
  attachmentCount: number;
}

export interface CloudSyncController {
  phase: CloudSyncPhase;
  linked: boolean;
  headerLabel: string;
  settingsProps: CloudSyncSectionProps;
  requestSync(): void;
  loadAttachment(attachmentId: string): Promise<Attachment | undefined>;
}

const api = createSyncApiClient();
const emptyOverview: SyncOverview = {
  linked: false,
  uploadApproved: false,
  cursor: "0",
  pendingCount: 0,
  conflictCount: 0,
};

function isQuotaError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as { name?: unknown; cause?: unknown; inner?: unknown };
  return candidate.name === "QuotaExceededError"
    || isQuotaError(candidate.cause, seen)
    || isQuotaError(candidate.inner, seen);
}

function syncErrorMessage(error: unknown): string {
  if (error instanceof LedgerDataError && error.code === "account-mismatch") {
    return "当前 Cloudflare 账号与这台设备已连接的账号不同。请重新登录原账号，账目不会被合并。";
  }
  if (error instanceof SyncApiError && error.code === "unauthorized") {
    return "登录已过期，请重新登录后继续同步。本机账目不受影响。";
  }
  if (error instanceof SyncApiError && error.code === "quota") {
    return "云端截图空间已达上限，待同步修改仍保存在本机。可删除不再需要的截图后重试。";
  }
  if (error instanceof SyncIncompleteError) {
    return "云端数据较多，本轮已安全保存一部分。请再次同步以继续读取剩余记录。";
  }
  if (isQuotaError(error)) {
    return "本机存储空间不足，云端截图尚未完整下载。请释放空间后重试。";
  }
  return "云同步暂时没有完成，所有待同步修改仍保存在本机。";
}

function isCloudStateChange(error: unknown): boolean {
  return (
    error instanceof SyncGenerationChangedError ||
    (error instanceof LedgerDataError && error.code === "sync-generation-mismatch") ||
    (error instanceof SyncApiError && (
      error.code === "stale_cloud_generation" ||
      error.code === "cloud_sync_disabled" ||
      error.code === "account_deletion_in_progress"
    ))
  );
}

const CLOUD_STATE_CHANGED_MESSAGE =
  "云端账本状态已变化。为避免上传到新的云端账本，请重新确认开启同步；本机账目不受影响。";

function formatEntryConflict(entry: LedgerEntry): string {
  if (entry.deletedAt) {
    try {
      const deletedAt = new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(entry.deletedAt));
      return `已删除 · ${deletedAt}`;
    } catch {
      return "已删除";
    }
  }
  const sign = entry.amountMinor < 0 ? "−" : "+";
  let occurredAt = "时间未知";
  try {
    occurredAt = entryToLocalDateTimeInput(
      entry.occurredAt,
      entry.timezoneOffsetMinutes,
    ).replace("T", " ");
  } catch {
    // Keep the conflict resolvable even if a legacy timestamp cannot be formatted.
  }
  const detail = [
    `${sign}${formatCny(Math.abs(entry.amountMinor))}`,
    entry.note || "无文字",
    occurredAt,
    entry.attachmentId ? "有截图" : "无截图",
  ].join(" · ");
  return detail;
}

function formatSettingsConflict(settings: AppSettings): string {
  return `初始余额 ${formatCny(settings.initialBalanceMinor)}`;
}

function conflictView(conflict: SyncConflict): CloudConflictView {
  if (conflict.entityType === "settings") {
    return {
      id: conflict.id,
      label: "初始余额",
      localValue: formatSettingsConflict(conflict.localPayload as AppSettings),
      cloudValue: formatSettingsConflict(conflict.remotePayload as AppSettings),
    };
  }
  const local = conflict.localPayload as LedgerEntry;
  const remote = conflict.remotePayload as LedgerEntry;
  return {
    id: conflict.id,
    label: local.note || remote.note || "截图记录",
    localValue: formatEntryConflict(local),
    cloudValue: formatEntryConflict(remote),
    localAttachmentId: local.deletedAt ? undefined : local.attachmentId,
    cloudAttachmentId: remote.deletedAt ? undefined : remote.attachmentId,
  };
}

function loginUrl(): string {
  if (typeof window === "undefined") return "/api/login";
  const target = new URL("/api/login", window.location.origin);
  target.searchParams.set(
    "returnTo",
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  return target.toString();
}

function logoutUrl(): string {
  if (typeof window === "undefined") return "/api/logout?returnTo=%2F";
  const target = new URL("/api/logout", window.location.origin);
  target.searchParams.set(
    "returnTo",
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
  );
  return target.toString();
}

function phaseLabel(phase: CloudSyncPhase, pendingCount: number): string {
  switch (phase) {
    case "checking": return "检查同步";
    case "unavailable": return "只存本机";
    case "signed-out": return "未登录";
    case "ready": return "待开启同步";
    case "linking": return "正在连接";
    case "syncing": return pendingCount ? `同步中 · ${pendingCount}` : "同步中";
    case "deleting": return "正在删除云端数据";
    case "synced": return "已同步";
    case "offline": return pendingCount ? `离线 · 待同步 ${pendingCount}` : "离线可用";
    case "conflict": return "同步有冲突";
    case "account-mismatch": return "账号不匹配";
    case "error": return pendingCount ? `待同步 ${pendingCount}` : "同步失败";
  }
}

export function useCloudSync(): CloudSyncController {
  const configured = import.meta.env.VITE_CLOUD_SYNC_ENABLED === "true";
  const [online, setOnline] = useState(() => navigator.onLine);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(
    configured ? "checking" : "signed-out",
  );
  const [session, setSession] = useState<SessionResponse>();
  const [operation, setOperation] = useState<Operation>("idle");
  const [message, setMessage] = useState<string>();
  const [snapshot, setSnapshot] = useState<LocalSyncSnapshot>({
    overview: emptyOverview,
    conflicts: [],
    entryCount: 0,
    attachmentCount: 0,
  });
  const syncPromise = useRef<Promise<void> | undefined>(undefined);
  const sessionAuthenticatedRef = useRef(false);
  const cloudSyncEnabledRef = useRef(false);

  useEffect(() => {
    const subscription = liveQuery(async (): Promise<LocalSyncSnapshot> => {
      const [overview, conflicts, entries] = await Promise.all([
        getSyncOverview(),
        ledgerDb.syncConflicts.toArray(),
        listActiveEntries(),
      ]);
      const attachmentIds = new Set(
        entries.flatMap((entry) => entry.attachmentId ? [entry.attachmentId] : []),
      );
      const attachmentCount = attachmentIds.size
        ? await ledgerDb.attachments.filter((attachment) => attachmentIds.has(attachment.id)).count()
        : 0;
      return { overview, conflicts, entryCount: entries.length, attachmentCount };
    }).subscribe({
      next: setSnapshot,
      error: () => setMessage("无法读取本机同步状态，记账功能仍可继续使用。"),
    });
    return () => subscription.unsubscribe();
  }, []);

  const stopForCloudStateChange = useCallback(async (
    knownSession?: SessionResponse,
  ): Promise<void> => {
    sessionAuthenticatedRef.current = false;
    cloudSyncEnabledRef.current = false;
    setSessionStatus("checking");
    setOperation("idle");
    setMessage(CLOUD_STATE_CHANGED_MESSAGE);
    try {
      const next = knownSession ?? await api.getSession();
      const overview = await getSyncOverview();
      if (
        overview.linked &&
        overview.accountId === next.user.id
      ) {
        await unlinkSyncAccount(next.user.id);
      }
      sessionAuthenticatedRef.current = true;
      setSession(next);
      setSessionStatus("authenticated");
      if (overview.linked && overview.accountId !== next.user.id) {
        setOperation("error");
        setMessage(syncErrorMessage(
          new LedgerDataError("账号不匹配", "account-mismatch"),
        ));
      }
    } catch (error) {
      setSession(undefined);
      if (error instanceof SyncApiError && error.code === "unauthorized") {
        setSessionStatus("signed-out");
      } else {
        setSessionStatus("error");
        setOperation("error");
        setMessage(syncErrorMessage(error));
      }
    }
  }, []);

  const runSync = useCallback((sessionConfirmed = false): Promise<void> => {
    if (
      !configured ||
      !navigator.onLine ||
      (!sessionConfirmed && (
        !sessionAuthenticatedRef.current ||
        !cloudSyncEnabledRef.current
      ))
    ) {
      return Promise.resolve();
    }
    if (syncPromise.current) return syncPromise.current;
    setOperation("syncing");
    setMessage(undefined);
    const running = syncNow()
      .then(() => {
        setOperation("idle");
      })
      .catch(async (error: unknown) => {
        if (isCloudStateChange(error)) {
          await stopForCloudStateChange();
          return;
        }
        setOperation("error");
        setMessage(syncErrorMessage(error));
        if (error instanceof SyncApiError && error.code === "unauthorized") {
          sessionAuthenticatedRef.current = false;
          cloudSyncEnabledRef.current = false;
          setSessionStatus("signed-out");
          setSession(undefined);
        }
      })
      .finally(() => {
        syncPromise.current = undefined;
      });
    syncPromise.current = running;
    return running;
  }, [configured, stopForCloudStateChange]);

  const checkSession = useCallback(async (syncAfterCheck = false): Promise<void> => {
    if (!configured || !navigator.onLine) return;
    sessionAuthenticatedRef.current = false;
    setSessionStatus("checking");
    try {
      const next = await api.getSession();
      sessionAuthenticatedRef.current = true;
      cloudSyncEnabledRef.current = false;
      setSession(next);
      setSessionStatus("authenticated");
      const overview = await getSyncOverview();
      if (overview.linked && overview.accountId !== next.user.id) {
        setOperation("error");
        setMessage(syncErrorMessage(new LedgerDataError("账号不匹配", "account-mismatch")));
        return;
      }
      if (
        overview.linked &&
        (
          next.cloud.syncStatus !== "enabled" ||
          overview.generation !== next.cloud.generation
        )
      ) {
        await stopForCloudStateChange(next);
        return;
      }
      cloudSyncEnabledRef.current =
        next.cloud.syncStatus === "enabled" && overview.linked;
      setMessage(undefined);
      if (
        syncAfterCheck &&
        next.cloud.syncStatus === "enabled" &&
        overview.linked &&
        overview.uploadApproved
      ) {
        void runSync(true);
      }
    } catch (error) {
      sessionAuthenticatedRef.current = false;
      cloudSyncEnabledRef.current = false;
      setSession(undefined);
      if (error instanceof SyncApiError && (
        error.code === "unauthorized" || error.code === "invalid-response"
      )) {
        setSessionStatus("signed-out");
      } else {
        setSessionStatus("error");
        setMessage(syncErrorMessage(error));
      }
    }
  }, [configured, runSync, stopForCloudStateChange]);

  useEffect(() => {
    if (!configured) return undefined;
    void checkSession(true);
    const handleOnline = () => {
      setOnline(true);
      void checkSession(true);
    };
    const handleOffline = () => setOnline(false);
    const handleVisible = () => {
      if (document.visibilityState === "visible") void checkSession(true);
    };
    const handleLocalChange = () => void runSync();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener(SYNC_LOCAL_CHANGE_EVENT, handleLocalChange);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener(SYNC_LOCAL_CHANGE_EVENT, handleLocalChange);
    };
  }, [checkSession, configured, runSync]);

  const enable = useCallback(async () => {
    if (!session) return;
    setOperation("linking");
    setMessage(undefined);
    try {
      const enabledGeneration = await api.enableCloudSync(session.cloud.generation);
      const nextSession = await api.getSession();
      if (
        nextSession.user.id !== session.user.id ||
        nextSession.cloud.syncStatus !== "enabled" ||
        nextSession.cloud.generation !== enabledGeneration
      ) {
        throw new SyncApiError(
          "invalid-response",
          "The enabled cloud generation did not match the refreshed session.",
        );
      }
      const overview = await getSyncOverview();
      if (
        overview.linked &&
        overview.accountId === nextSession.user.id &&
        overview.generation !== nextSession.cloud.generation
      ) {
        await unlinkSyncAccount(overview.accountId);
      }
      await linkSyncAccount(nextSession, true);
      sessionAuthenticatedRef.current = true;
      cloudSyncEnabledRef.current = true;
      setSession(nextSession);
      setSessionStatus("authenticated");
      await runSync(true);
    } catch (error) {
      if (isCloudStateChange(error)) {
        await stopForCloudStateChange();
        return;
      }
      setOperation("error");
      setMessage(syncErrorMessage(error));
    }
  }, [runSync, session, stopForCloudStateChange]);

  const deleteCloudData = useCallback(async () => {
    if (!session) return;
    cloudSyncEnabledRef.current = false;
    setOperation("deleting");
    setMessage(undefined);
    try {
      const deletedGeneration = session.cloud.generation;
      await api.deleteCloudData(deletedGeneration);
      const nextSession = await api.getSession();
      if (
        nextSession.user.id !== session.user.id ||
        nextSession.cloud.syncStatus !== "disabled" ||
        nextSession.cloud.generation !== deletedGeneration + 1
      ) {
        await stopForCloudStateChange(nextSession);
        return;
      }
      const overview = await getSyncOverview();
      if (overview.linked && overview.accountId === session.user.id) {
        await unlinkSyncAccount(session.user.id);
      }
      sessionAuthenticatedRef.current = true;
      cloudSyncEnabledRef.current = false;
      setSession(nextSession);
      setSessionStatus("authenticated");
      setOperation("idle");
      setMessage("云端账本和截图已删除；这台设备上的本机数据仍然保留。");
    } catch (error) {
      if (isCloudStateChange(error)) {
        await stopForCloudStateChange();
        return;
      }
      setOperation("error");
      setMessage(syncErrorMessage(error));
    }
  }, [session, stopForCloudStateChange]);

  const resolveConflict = useCallback(async (
    conflictId: string,
    resolution: "keep-local" | "use-cloud",
  ) => {
    const conflict = snapshot.conflicts.find((candidate) => candidate.id === conflictId);
    if (!conflict) return;
    try {
      await resolveSyncConflict(conflict.entityType, conflict.entityId, resolution);
      await runSync();
    } catch (error) {
      setOperation("error");
      setMessage(syncErrorMessage(error));
    }
  }, [runSync, snapshot.conflicts]);

  const loadAttachment = useCallback(async (attachmentId: string) => {
    const local = await getLocalAttachment(attachmentId);
    if (local || !configured || !online || !snapshot.overview.linked) return local;
    const generation = snapshot.overview.generation;
    if (!Number.isSafeInteger(generation) || !generation || generation < 1) return undefined;
    const entry = await ledgerDb.entries.filter((candidate) => candidate.attachmentId === attachmentId).first();
    if (!entry) return undefined;
    try {
      const remote = await api.getAttachment(attachmentId, generation);
      if (!remote || remote.entryId !== entry.id) return undefined;
      const attachment: Attachment = {
        id: attachmentId,
        entryId: entry.id,
        blob: remote.blob,
        mimeType: remote.mimeType,
        size: remote.size,
        width: remote.width,
        height: remote.height,
        createdAt: entry.createdAt,
      };
      await cacheRemoteAttachment(attachment, generation);
      return attachment;
    } catch (error) {
      if (isCloudStateChange(error)) await stopForCloudStateChange();
      return undefined;
    }
  }, [configured, online, snapshot.overview, stopForCloudStateChange]);

  const accountMismatch = Boolean(
    session && snapshot.overview.accountId && session.user.id !== snapshot.overview.accountId,
  );
  let phase: CloudSyncPhase;
  if (!configured) phase = "unavailable";
  else if (!online) phase = "offline";
  else if (accountMismatch) phase = "account-mismatch";
  else if (operation === "deleting" || session?.cloud.syncStatus === "deleting") phase = "deleting";
  else if (operation === "linking") phase = "linking";
  else if (sessionStatus === "checking") phase = "checking";
  else if (sessionStatus === "signed-out") phase = "signed-out";
  else if (sessionStatus === "error" || operation === "error") phase = "error";
  else if (session?.cloud.syncStatus !== "enabled") phase = "ready";
  else if (!snapshot.overview.linked) phase = "ready";
  else if (operation === "syncing") phase = "syncing";
  else if (snapshot.conflicts.length) phase = "conflict";
  else if (snapshot.overview.pendingCount) phase = "error";
  else phase = "synced";

  const email = snapshot.overview.accountEmail ?? session?.user.email;
  const settingsProps = useMemo<CloudSyncSectionProps>(() => ({
    phase,
    linked: snapshot.overview.linked,
    email,
    pendingCount: snapshot.overview.pendingCount,
    lastSyncedAt: snapshot.overview.lastSyncedAt,
    localEntryCount: snapshot.entryCount,
    localAttachmentCount: snapshot.attachmentCount,
    conflicts: snapshot.conflicts.map(conflictView),
    message,
    loginUrl: loginUrl(),
    logoutUrl: logoutUrl(),
    canDeleteCloudData: sessionStatus === "authenticated" &&
      !accountMismatch &&
      (session?.cloud.syncStatus === "enabled" || session?.cloud.syncStatus === "deleting"),
    deletionBusy: operation === "deleting",
    onEnable: () => void enable(),
    onRetry: () => {
      void checkSession(true);
    },
    onDeleteCloudData: () => void deleteCloudData(),
    loadAttachment,
    onResolveConflict: (id, resolution) => void resolveConflict(id, resolution),
  }), [
    accountMismatch,
    checkSession,
    deleteCloudData,
    email,
    enable,
    loadAttachment,
    message,
    operation,
    phase,
    resolveConflict,
    session?.cloud.syncStatus,
    sessionStatus,
    snapshot,
  ]);

  return {
    phase,
    linked: snapshot.overview.linked,
    headerLabel: phaseLabel(phase, snapshot.overview.pendingCount),
    settingsProps,
    requestSync: () => {
      if (snapshot.overview.linked && snapshot.overview.uploadApproved) void runSync();
    },
    loadAttachment,
  };
}
