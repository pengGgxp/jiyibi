import {
  CheckCircle2,
  Cloud,
  CloudAlert,
  CloudOff,
  CloudUpload,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { Attachment } from "../domain";
import { useObjectUrl } from "../hooks/useObjectUrl";

export type CloudSyncPhase =
  | "checking"
  | "unavailable"
  | "signed-out"
  | "ready"
  | "linking"
  | "syncing"
  | "deleting"
  | "synced"
  | "offline"
  | "error"
  | "conflict"
  | "account-mismatch";

export interface CloudConflictView {
  id: string;
  label: string;
  localValue: string;
  cloudValue: string;
  localAttachmentId?: string;
  cloudAttachmentId?: string;
}

export interface CloudSyncSectionProps {
  phase: CloudSyncPhase;
  linked: boolean;
  email?: string;
  pendingCount: number;
  lastSyncedAt?: string;
  localEntryCount: number;
  localAttachmentCount: number;
  conflicts: CloudConflictView[];
  message?: string;
  loginUrl: string;
  logoutUrl: string;
  canDeleteCloudData: boolean;
  deletionBusy: boolean;
  loadAttachment(attachmentId: string): Promise<Attachment | undefined>;
  onEnable(): void;
  onRetry(): void;
  onDeleteCloudData(): void;
  onResolveConflict(id: string, resolution: "keep-local" | "use-cloud"): void;
}

function ConflictVersion({
  side,
  value,
  attachmentId,
  loadAttachment,
}: {
  side: "本机" | "云端";
  value: string;
  attachmentId?: string;
  loadAttachment(attachmentId: string): Promise<Attachment | undefined>;
}) {
  const [attachment, setAttachment] = useState<Attachment>();
  const [failed, setFailed] = useState(false);
  const url = useObjectUrl(attachment?.blob);

  useEffect(() => {
    let active = true;
    setAttachment(undefined);
    setFailed(false);
    if (!attachmentId) return () => { active = false; };
    void loadAttachment(attachmentId)
      .then((next) => {
        if (!active) return;
        setAttachment(next);
        setFailed(!next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [attachmentId, loadAttachment]);

  return (
    <div>
      <dt>{side}</dt>
      <dd>{value}</dd>
      {url ? <img className="sync-conflict-thumbnail" src={url} alt={`${side}截图`} /> : null}
      {attachmentId && failed ? <span className="sync-conflict-image-status">截图暂不可用</span> : null}
    </div>
  );
}

function lastSyncLabel(value?: string): string {
  if (!value) return "尚未完成同步";
  try {
    return `上次同步 ${new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value))}`;
  } catch {
    return "同步时间未知";
  }
}

function PhaseIcon({ phase }: { phase: CloudSyncPhase }) {
  if (phase === "checking" || phase === "linking" || phase === "syncing" || phase === "deleting") {
    return <LoaderCircle className="spin" aria-hidden="true" />;
  }
  if (phase === "synced") return <CheckCircle2 aria-hidden="true" />;
  if (phase === "offline" || phase === "unavailable") return <CloudOff aria-hidden="true" />;
  if (phase === "error" || phase === "conflict" || phase === "account-mismatch") {
    return <CloudAlert aria-hidden="true" />;
  }
  return <Cloud aria-hidden="true" />;
}

function phaseCopy(
  phase: CloudSyncPhase,
  pendingCount: number,
  deletionBusy: boolean,
): string {
  switch (phase) {
    case "checking":
      return "正在检查登录状态";
    case "unavailable":
      return "当前部署仅支持本机账本";
    case "signed-out":
      return "登录后可在不同设备间同步";
    case "ready":
      return "登录成功，尚未上传本机数据";
    case "linking":
      return "正在连接本机账本";
    case "syncing":
      return pendingCount ? `正在同步 ${pendingCount} 项变更` : "正在检查云端变更";
    case "deleting":
      return deletionBusy ? "正在删除云端数据" : "云端删除尚未完成";
    case "synced":
      return "本机与云端一致";
    case "offline":
      return pendingCount ? `离线，${pendingCount} 项等待同步` : "离线，继续使用本机账本";
    case "conflict":
      return "有多设备修改需要选择";
    case "account-mismatch":
      return "这台设备已连接另一个账号";
    case "error":
      return pendingCount ? `同步失败，${pendingCount} 项仍保存在本机` : "暂时无法连接云端";
  }
}

export function CloudSyncSection({
  phase,
  linked,
  email,
  pendingCount,
  lastSyncedAt,
  localEntryCount,
  localAttachmentCount,
  conflicts,
  message,
  loginUrl,
  logoutUrl,
  canDeleteCloudData,
  deletionBusy,
  loadAttachment,
  onEnable,
  onRetry,
  onDeleteCloudData,
  onResolveConflict,
}: CloudSyncSectionProps) {
  const confirmationId = useId();
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const busy = phase === "checking" || phase === "linking" || phase === "syncing" || deletionBusy;

  useEffect(() => {
    if (!canDeleteCloudData) {
      setConfirmingDeletion(false);
      setDeletionConfirmation("");
    }
  }, [canDeleteCloudData]);
  return (
    <section className="settings-section" aria-labelledby="cloud-sync-title">
      <div className="settings-section-heading">
        <div className="settings-icon"><Cloud aria-hidden="true" /></div>
        <div>
          <h3 id="cloud-sync-title">账号与云同步</h3>
          <p>本机先保存，联网后再同步到 Cloudflare。</p>
        </div>
      </div>

      <div className={`cloud-sync-state cloud-sync-state--${phase}`} aria-live="polite">
        <span className="cloud-sync-state-icon"><PhaseIcon phase={phase} /></span>
        <div>
          <strong>{phaseCopy(phase, pendingCount, deletionBusy)}</strong>
          <span>{email ?? "当前未连接账号"}</span>
        </div>
      </div>

      {phase === "signed-out" ? (
        <div className="cloud-sync-actions">
          <p>登录通过 GitHub OAuth 完成，应用不会接触或保存你的 GitHub 密码。</p>
          <a className="secondary-button" href={loginUrl}>
            <LogIn aria-hidden="true" /> 使用 GitHub 登录
          </a>
        </div>
      ) : null}

      {phase === "ready" || phase === "linking" ? (
        <div className="sync-consent" role="region" aria-labelledby="sync-consent-title">
          <div>
            <ShieldCheck aria-hidden="true" />
            <div>
              <h4 id="sync-consent-title">确认开启同步</h4>
              <p>
                将上传本机 {localEntryCount} 笔记录和 {localAttachmentCount} 张截图，并合并该账号已有的云端记录。
              </p>
            </div>
          </div>
          <button type="button" className="secondary-button" disabled={busy} onClick={onEnable}>
            {phase === "linking" ? <LoaderCircle className="spin" aria-hidden="true" /> : <CloudUpload aria-hidden="true" />}
            {phase === "linking" ? "正在开启" : "开启并开始同步"}
          </button>
        </div>
      ) : null}

      {linked ? (
        <div className="cloud-account-details">
          <dl>
            <div><dt>待同步</dt><dd>{pendingCount} 项</dd></div>
            <div><dt>状态</dt><dd>{lastSyncLabel(lastSyncedAt)}</dd></div>
          </dl>
          <div className="cloud-sync-buttons">
            <button type="button" className="secondary-button" disabled={busy || phase === "offline"} onClick={onRetry}>
              <RefreshCw className={phase === "syncing" ? "spin" : undefined} aria-hidden="true" />
              立即同步
            </button>
            <a className="text-button" href={logoutUrl}>
              退出云端会话 <LogOut aria-hidden="true" />
            </a>
          </div>
          <p className="device-copy-warning">退出不会清除这台设备上的离线账本。</p>
        </div>
      ) : null}

      {canDeleteCloudData ? (
        <div className="cloud-delete-zone">
          {!confirmingDeletion ? (
            <button
              type="button"
              className="text-button cloud-delete-trigger"
              onClick={() => setConfirmingDeletion(true)}
            >
              <Trash2 aria-hidden="true" />
              {phase === "deleting" ? "继续删除云端数据" : "删除云端副本"}
            </button>
          ) : (
            <div className="cloud-delete-confirmation" role="region" aria-labelledby={`${confirmationId}-title`}>
              <div>
                <h4 id={`${confirmationId}-title`}>删除全部云端数据</h4>
                <p>
                  D1 中的账目和同步历史、Workers KV 中的截图将永久删除。当前设备的本机账本会保留，其他设备会停止同步，直到再次明确开启。
                </p>
              </div>
              <label htmlFor={confirmationId}>输入“删除云端数据”确认</label>
              <input
                id={confirmationId}
                type="text"
                autoComplete="off"
                value={deletionConfirmation}
                onChange={(event) => setDeletionConfirmation(event.target.value)}
              />
              <div className="cloud-delete-actions">
                <button
                  type="button"
                  className="destructive-button"
                  disabled={deletionConfirmation !== "删除云端数据" || busy || phase === "offline"}
                  onClick={onDeleteCloudData}
                >
                  {deletionBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {deletionBusy ? "正在删除" : "永久删除云端数据"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={deletionBusy}
                  onClick={() => {
                    setConfirmingDeletion(false);
                    setDeletionConfirmation("");
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {message ? <p className="inline-message cloud-sync-message" role={phase === "error" || phase === "account-mismatch" ? "alert" : "status"}>{message}</p> : null}

      {conflicts.length ? (
        <div className="sync-conflicts" role="region" aria-labelledby="sync-conflicts-title">
          <div className="sync-conflicts-heading">
            <CloudAlert aria-hidden="true" />
            <div>
              <h4 id="sync-conflicts-title">需要选择的修改</h4>
              <p>选择后会继续同步，未处理前保留本机版本。</p>
            </div>
          </div>
          <ul>
            {conflicts.map((conflict) => (
              <li key={conflict.id}>
                <strong>{conflict.label}</strong>
                <dl>
                  <ConflictVersion side="本机" value={conflict.localValue} attachmentId={conflict.localAttachmentId} loadAttachment={loadAttachment} />
                  <ConflictVersion side="云端" value={conflict.cloudValue} attachmentId={conflict.cloudAttachmentId} loadAttachment={loadAttachment} />
                </dl>
                <div>
                  <button type="button" className="secondary-button compact-button" onClick={() => onResolveConflict(conflict.id, "keep-local")}>保留本机</button>
                  <button type="button" className="text-button" onClick={() => onResolveConflict(conflict.id, "use-cloud")}>使用云端</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {phase === "unavailable" ? (
        <p className="cloud-unavailable-note">Cloudflare Pages 版本支持登录同步；当前版本仍可完整使用本机账本和加密备份。</p>
      ) : null}
    </section>
  );
}
