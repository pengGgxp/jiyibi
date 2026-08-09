import {
  ArchiveRestore,
  CheckCircle2,
  Download,
  HardDrive,
  KeyRound,
  LoaderCircle,
  MonitorDown,
  RefreshCw,
  Save,
  ShieldCheck,
  Target,
  Upload,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  BackupError,
  createBackupFileName,
  createEncryptedBackup,
  decryptBackup,
  restorePreparedBackup,
  setInitialBalance,
  setMonthEndBalanceGoal,
  type PreparedBackup,
} from "../data";
import { formatCny, parseSignedAmountToMinor, type AppSettings } from "../domain";
import type { PwaState } from "../hooks/usePwa";
import { useStorageEstimate } from "../hooks/useStorageEstimate";
import { CloudSyncSection, type CloudSyncSectionProps } from "./CloudSyncSection";
import { Modal } from "./Modal";

interface SettingsDialogProps {
  open: boolean;
  settings?: AppSettings;
  pwa: PwaState;
  cloudSync: CloudSyncSectionProps;
  onClose(): void;
  onDataChanged(): void;
}

function signedInput(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function backupErrorMessage(reason: unknown): string {
  if (reason instanceof BackupError) {
    switch (reason.code) {
      case "password-required":
        return "请输入备份密码";
      case "decrypt-failed":
        return "密码错误，或备份文件已经损坏";
      case "unsupported-version":
        return "这个备份版本暂不支持，请使用更新版本的记一笔";
      case "invalid-envelope":
      case "invalid-payload":
        return "无法识别这个备份文件";
      case "restore-failed":
        return "恢复失败，原有账目没有被替换";
    }
  }
  return reason instanceof Error ? reason.message : "操作失败，请重试";
}

export function SettingsDialog({
  open,
  settings,
  pwa,
  cloudSync,
  onClose,
  onDataChanged,
}: SettingsDialogProps) {
  const [initialBalance, setInitialBalanceInput] = useState("0.00");
  const [balanceError, setBalanceError] = useState<string>();
  const [balanceStatus, setBalanceStatus] = useState<string>();
  const [savingBalance, setSavingBalance] = useState(false);
  const [goalEnabled, setGoalEnabled] = useState(false);
  const [goalInput, setGoalInput] = useState("0.00");
  const [goalError, setGoalError] = useState<string>();
  const [goalStatus, setGoalStatus] = useState<string>();
  const [savingGoal, setSavingGoal] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportStatus, setExportStatus] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restorePassword, setRestorePassword] = useState("");
  const [prepared, setPrepared] = useState<PreparedBackup>();
  const [restoreStatus, setRestoreStatus] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const { estimate, error: estimateError, refresh: refreshEstimate } = useStorageEstimate(open);

  useEffect(() => {
    if (!open || !settings) return;
    setInitialBalanceInput(signedInput(settings.initialBalanceMinor));
    setGoalEnabled(settings.monthEndBalanceGoalMinor !== undefined);
    setGoalInput(signedInput(settings.monthEndBalanceGoalMinor ?? 0));
  }, [open, settings]);

  useEffect(() => {
    if (!open) {
      setBalanceError(undefined);
      setBalanceStatus(undefined);
      setGoalError(undefined);
      setGoalStatus(undefined);
      setExportPassword("");
      setExportConfirm("");
      setExportStatus(undefined);
      setRestoreFile(undefined);
      setRestorePassword("");
      setPrepared(undefined);
      setRestoreStatus(undefined);
    }
  }, [open]);

  const saveBalance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let minor: number;
    try {
      minor = parseSignedAmountToMinor(initialBalance);
      setBalanceError(undefined);
    } catch {
      setBalanceError("请输入有效金额，最多保留两位小数");
      return;
    }
    setSavingBalance(true);
    setBalanceStatus(undefined);
    try {
      await setInitialBalance(minor);
      setBalanceStatus("初始余额已更新");
      onDataChanged();
    } catch {
      setBalanceError("初始余额没有保存，请重试");
    } finally {
      setSavingBalance(false);
    }
  };

  const saveGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let minor: number | undefined;
    if (goalEnabled) {
      try {
        minor = parseSignedAmountToMinor(goalInput);
        setGoalError(undefined);
      } catch {
        setGoalError("请输入有效金额，最多保留两位小数");
        return;
      }
    }
    setSavingGoal(true);
    setGoalStatus(undefined);
    try {
      await setMonthEndBalanceGoal(minor);
      setGoalStatus(goalEnabled ? "月末余额底线已更新" : "月末余额底线已关闭");
      onDataChanged();
    } catch {
      setGoalError("月末余额底线没有保存，请重试");
    } finally {
      setSavingGoal(false);
    }
  };

  const exportBackup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!exportPassword) {
      setExportStatus("请输入备份密码");
      return;
    }
    if (exportPassword !== exportConfirm) {
      setExportStatus("两次输入的密码不一致");
      return;
    }
    setExporting(true);
    setExportStatus(undefined);
    try {
      const blob = await createEncryptedBackup(exportPassword);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = createBackupFileName();
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setExportPassword("");
      setExportConfirm("");
      setExportStatus("加密备份已下载");
      void refreshEstimate();
    } catch (reason) {
      setExportStatus(backupErrorMessage(reason));
    } finally {
      setExporting(false);
    }
  };

  const inspectRestore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!restoreFile) {
      setRestoreStatus("请选择 .jiyibi 备份文件");
      return;
    }
    if (!restorePassword) {
      setRestoreStatus("请输入这个备份的密码");
      return;
    }
    setRestoring(true);
    setPrepared(undefined);
    setRestoreStatus(undefined);
    try {
      setPrepared(await decryptBackup(restoreFile, restorePassword));
      setRestorePassword("");
    } catch (reason) {
      setRestoreStatus(backupErrorMessage(reason));
    } finally {
      setRestoring(false);
    }
  };

  const confirmRestore = async () => {
    if (!prepared) return;
    setRestoring(true);
    setRestoreStatus(undefined);
    try {
      await restorePreparedBackup(prepared);
      setPrepared(undefined);
      setRestoreFile(undefined);
      setRestoreStatus("备份已恢复，余额和记录已更新");
      onDataChanged();
      void refreshEstimate();
    } catch (reason) {
      setRestoreStatus(backupErrorMessage(reason));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Modal open={open} title="设置" description="管理本机账本、云同步和备份。" size="wide" onClose={onClose}>
      <div className="settings-stack">
        <section className="settings-section" aria-labelledby="balance-setting-title">
          <div className="settings-section-heading">
            <div className="settings-icon"><HardDrive aria-hidden="true" /></div>
            <div>
              <h3 id="balance-setting-title">初始余额</h3>
              <p>当前余额会在这个数值上累计每笔收支。</p>
            </div>
          </div>
          <form className="inline-setting-form" onSubmit={(event) => void saveBalance(event)} noValidate>
            <div className="field-group compact-field">
              <label htmlFor="initial-balance">人民币金额</label>
              <div className="signed-input">
                <span aria-hidden="true">¥</span>
                <input
                  id="initial-balance"
                  value={initialBalance}
                  inputMode="decimal"
                  aria-invalid={Boolean(balanceError)}
                  aria-describedby={balanceError ? "initial-balance-error" : undefined}
                  onChange={(event) => {
                    setInitialBalanceInput(event.target.value);
                    setBalanceError(undefined);
                    setBalanceStatus(undefined);
                  }}
                />
              </div>
              {balanceError ? <p id="initial-balance-error" className="field-error">{balanceError}</p> : null}
            </div>
            <button type="submit" className="secondary-button" disabled={savingBalance}>
              {savingBalance ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              保存余额
            </button>
          </form>
          {balanceStatus ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {balanceStatus}</p> : null}
        </section>

        <section className="settings-section" aria-labelledby="goal-setting-title">
          <div className="settings-section-heading">
            <div className="settings-icon"><Target aria-hidden="true" /></div>
            <div>
              <h3 id="goal-setting-title">月末余额底线</h3>
              <p>每个自然月结束时，希望余额不少于这个数；只比较实际余额。</p>
            </div>
          </div>
          <form className="goal-setting-form" onSubmit={(event) => void saveGoal(event)} noValidate>
            <label className="setting-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={goalEnabled}
                onChange={(event) => {
                  setGoalEnabled(event.target.checked);
                  setGoalError(undefined);
                  setGoalStatus(undefined);
                }}
              />
              <span className="toggle-control" aria-hidden="true"><span /></span>
              <span>
                <strong>每月显示余额目标</strong>
                <small>打开应用即可看到当前差额</small>
              </span>
            </label>
            <div className="inline-setting-form">
              <div className="field-group compact-field">
                <label htmlFor="month-end-balance-goal">人民币金额</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="month-end-balance-goal"
                    value={goalInput}
                    inputMode="decimal"
                    disabled={!goalEnabled}
                    aria-invalid={Boolean(goalError)}
                    aria-describedby={goalError ? "month-end-balance-goal-error" : undefined}
                    onChange={(event) => {
                      setGoalInput(event.target.value);
                      setGoalError(undefined);
                      setGoalStatus(undefined);
                    }}
                  />
                </div>
                {goalError ? <p id="month-end-balance-goal-error" className="field-error">{goalError}</p> : null}
              </div>
              <button type="submit" className="secondary-button" disabled={savingGoal}>
                {savingGoal ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                保存目标
              </button>
            </div>
          </form>
          {goalStatus ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {goalStatus}</p> : null}
        </section>

        <CloudSyncSection {...cloudSync} />

        <section className="settings-section" aria-labelledby="device-setting-title">
          <div className="settings-section-heading">
            <div className="settings-icon"><MonitorDown aria-hidden="true" /></div>
            <div>
              <h3 id="device-setting-title">这台设备</h3>
              <p>{pwa.installed ? "已作为应用安装" : "账目只保存在当前浏览器"}</p>
            </div>
          </div>
          <div className="device-settings-grid">
            <div className="storage-meter">
              <div>
                <span>本机存储</span>
                <strong>
                  {estimate?.supported
                    ? `已用 ${bytesLabel(estimate.usage)}，可用 ${bytesLabel(estimate.available)}`
                    : estimateError ? "读取失败" : "浏览器未提供容量信息"}
                </strong>
              </div>
              {estimate?.supported && estimate.quota > 0 ? (
                <progress max={estimate.quota} value={estimate.usage} aria-label="本机存储用量" />
              ) : null}
            </div>
            {pwa.canInstall ? (
              <button type="button" className="secondary-button" onClick={() => void pwa.install()}>
                <MonitorDown aria-hidden="true" /> 安装应用
              </button>
            ) : null}
            {pwa.needRefresh ? (
              <button type="button" className="secondary-button" onClick={() => void pwa.update()}>
                <RefreshCw aria-hidden="true" /> 更新应用
              </button>
            ) : null}
          </div>
        </section>

        <section className="settings-section backup-section" aria-labelledby="backup-setting-title">
          <div className="settings-section-heading">
            <div className="settings-icon"><ShieldCheck aria-hidden="true" /></div>
            <div>
              <h3 id="backup-setting-title">加密备份</h3>
              <p>密码不会保存，丢失后无法找回。</p>
            </div>
          </div>

          <details className="settings-disclosure">
            <summary><span><Download aria-hidden="true" /> 导出备份</span></summary>
            <form className="backup-form" onSubmit={(event) => void exportBackup(event)} noValidate>
              <div className="backup-fields">
                <div className="field-group compact-field">
                  <label htmlFor="export-password">设置密码</label>
                  <div className="password-input"><KeyRound aria-hidden="true" /><input id="export-password" type="password" autoComplete="new-password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} /></div>
                </div>
                <div className="field-group compact-field">
                  <label htmlFor="export-confirm">再次输入</label>
                  <div className="password-input"><KeyRound aria-hidden="true" /><input id="export-confirm" type="password" autoComplete="new-password" value={exportConfirm} onChange={(event) => setExportConfirm(event.target.value)} /></div>
                </div>
              </div>
              <button type="submit" className="secondary-button" disabled={exporting}>
                {exporting ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                {exporting ? "正在加密" : "下载加密备份"}
              </button>
              {exportStatus ? <p className="inline-message" role="status">{exportStatus}</p> : null}
            </form>
          </details>

          {cloudSync.linked ? (
            <div className="settings-disclosure settings-disclosure--disabled">
              <button
                type="button"
                className="settings-disclosure-disabled-trigger"
                aria-describedby="restore-unavailable-reason"
                disabled
              >
                <span><Upload aria-hidden="true" /> 恢复备份</span>
              </button>
              <p id="restore-unavailable-reason" className="settings-disclosure-disabled-copy">
                当前账本已连接云同步，暂不能恢复备份，以免覆盖云端数据。你仍可导出备份；需要恢复时，请使用尚未连接云同步的浏览器。
              </p>
            </div>
          ) : (
            <details className="settings-disclosure">
              <summary><span><Upload aria-hidden="true" /> 恢复备份</span></summary>
              <form className="backup-form" onSubmit={(event) => void inspectRestore(event)} noValidate>
                <div className="field-group compact-field">
                  <label htmlFor="restore-file">备份文件</label>
                  <input id="restore-file" className="file-input" type="file" accept=".jiyibi,application/vnd.jiyibi.backup+json,application/json" onChange={(event) => { setRestoreFile(event.target.files?.[0]); setPrepared(undefined); setRestoreStatus(undefined); }} />
                </div>
                <div className="field-group compact-field">
                  <label htmlFor="restore-password">备份密码</label>
                  <div className="password-input"><KeyRound aria-hidden="true" /><input id="restore-password" type="password" autoComplete="current-password" value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} /></div>
                </div>
                <button type="submit" className="secondary-button" disabled={restoring}>
                  {restoring ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
                  {restoring ? "正在检查" : "检查备份"}
                </button>
              </form>

              {prepared ? (
                <div className="restore-preview" role="region" aria-labelledby="restore-preview-title">
                  <div>
                    <h4 id="restore-preview-title">确认恢复</h4>
                    <p>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(prepared.preview.exportedAt))} 导出的备份</p>
                  </div>
                  <dl>
                    <div><dt>记录</dt><dd>{prepared.preview.entryCount} 笔</dd></div>
                    <div><dt>截图</dt><dd>{prepared.preview.attachmentCount} 张</dd></div>
                    <div><dt>初始余额</dt><dd>{formatCny(prepared.preview.initialBalanceMinor)}</dd></div>
                    <div><dt>月末底线</dt><dd>{prepared.preview.monthEndBalanceGoalMinor === undefined ? "未设置" : formatCny(prepared.preview.monthEndBalanceGoalMinor)}</dd></div>
                  </dl>
                  <p className="restore-warning">恢复会整体替换当前设备上的账目，且不能撤销。</p>
                  <button type="button" className="destructive-button" disabled={restoring} onClick={() => void confirmRestore()}>
                    {restoring ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
                    确认覆盖并恢复
                  </button>
                </div>
              ) : null}
              {restoreStatus ? <p className="inline-message" role="status">{restoreStatus}</p> : null}
            </details>
          )}
        </section>
      </div>
    </Modal>
  );
}
