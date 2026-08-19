import {
  ArchiveRestore,
  CalendarDays,
  CheckCircle2,
  Download,
  HardDrive,
  KeyRound,
  LoaderCircle,
  MonitorDown,
  RefreshCw,
  Save,
  ShieldCheck,
  TrendingUp,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BackupError,
  createBackupFileName,
  createEncryptedBackup,
  decryptBackup,
  restorePreparedBackup,
  setInitialBalance,
  setInitialSavings,
  setPayCyclePlan,
  setSavingsTargetOverride,
  type PreparedBackup,
} from "../data";
import {
  formatCny,
  parseSignedAmountToMinor,
  savingsTargetFromPlan,
  type AppSettings,
} from "../domain";
import type { PwaState } from "../hooks/usePwa";
import { useStorageEstimate } from "../hooks/useStorageEstimate";
import { CloudSyncSection, type CloudSyncSectionProps } from "./CloudSyncSection";
import { Modal } from "./Modal";

interface SettingsDialogProps {
  open: boolean;
  settings?: AppSettings;
  openingSavingsMinor?: number;
  pwa: PwaState;
  cloudSync: CloudSyncSectionProps;
  onClose(): void;
  onDataChanged(): void;
  onOpenIncomeForecast(): void;
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

function readableDateKey(dateKey: string): string {
  const [, month, day] = dateKey.split("-");
  return month && day ? `${Number(month)} 月 ${Number(day)} 日` : dateKey;
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
  openingSavingsMinor = 0,
  pwa,
  cloudSync,
  onClose,
  onDataChanged,
  onOpenIncomeForecast,
}: SettingsDialogProps) {
  const [initialBalance, setInitialBalanceInput] = useState("0.00");
  const [balanceError, setBalanceError] = useState<string>();
  const [balanceStatus, setBalanceStatus] = useState<string>();
  const [savingBalance, setSavingBalance] = useState(false);
  const [payCycleEnabled, setPayCycleEnabled] = useState(false);
  const [paydayInput, setPaydayInput] = useState("1");
  const [cycleGoalInput, setCycleGoalInput] = useState("0.00");
  const [paydayError, setPaydayError] = useState<string>();
  const [cycleGoalError, setCycleGoalError] = useState<string>();
  const [payCycleError, setPayCycleError] = useState<string>();
  const [payCycleStatus, setPayCycleStatus] = useState<string>();
  const [savingPayCycle, setSavingPayCycle] = useState(false);
  const [initialSavingsInput, setInitialSavingsInput] = useState("0.00");
  const [initialSavingsError, setInitialSavingsError] = useState<string>();
  const [initialSavingsStatus, setInitialSavingsStatus] = useState<string>();
  const [savingInitialSavings, setSavingInitialSavings] = useState(false);
  const [cycleOverrideInput, setCycleOverrideInput] = useState("");
  const [cycleOverrideError, setCycleOverrideError] = useState<string>();
  const [cycleOverrideStatus, setCycleOverrideStatus] = useState<string>();
  const [savingCycleOverride, setSavingCycleOverride] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportStatus, setExportStatus] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File>();
  const [restorePassword, setRestorePassword] = useState("");
  const [prepared, setPrepared] = useState<PreparedBackup>();
  const [restoreStatus, setRestoreStatus] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const initializedForOpen = useRef(false);
  const { estimate, error: estimateError, refresh: refreshEstimate } = useStorageEstimate(open);

  useEffect(() => {
    if (!open) {
      initializedForOpen.current = false;
      return;
    }
    if (!settings || initializedForOpen.current) return;
    initializedForOpen.current = true;
    setInitialBalanceInput(signedInput(settings.initialBalanceMinor));
    setPayCycleEnabled(settings.payCycle !== undefined);
    setPaydayInput(String(settings.payCycle?.paydayDay ?? 1));
    setCycleGoalInput(signedInput(
      settings.payCycle
        ? savingsTargetFromPlan(settings.payCycle)
        : Math.max(settings.monthEndBalanceGoalMinor ?? 0, 0),
    ));
    setInitialSavingsInput(signedInput(openingSavingsMinor));
    setCycleOverrideInput(
      settings.savingsTargetOverride
        ? signedInput(settings.savingsTargetOverride.targetMinor)
        : "",
    );
  }, [open, openingSavingsMinor, settings]);

  useEffect(() => {
    if (!open) {
      setBalanceError(undefined);
      setBalanceStatus(undefined);
      setPaydayError(undefined);
      setCycleGoalError(undefined);
      setPayCycleError(undefined);
      setPayCycleStatus(undefined);
      setInitialSavingsError(undefined);
      setInitialSavingsStatus(undefined);
      setCycleOverrideError(undefined);
      setCycleOverrideStatus(undefined);
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

  const savePayCycle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let paydayDay = 1;
    let goalMinor = 0;
    if (payCycleEnabled) {
      if (!/^\d{1,2}$/.test(paydayInput) || (paydayDay = Number(paydayInput)) < 1 || paydayDay > 31) {
        setPaydayError("发薪日请输入 1 到 31 的整数");
        return;
      }
      try {
        goalMinor = parseSignedAmountToMinor(cycleGoalInput);
        if (goalMinor < 0) {
          setCycleGoalError("默认留存目标不能小于 0");
          return;
        }
        setCycleGoalError(undefined);
      } catch {
        setCycleGoalError("默认留存目标请输入有效金额，最多保留两位小数");
        return;
      }
    }
    setPaydayError(undefined);
    setCycleGoalError(undefined);
    setPayCycleError(undefined);
    setSavingPayCycle(true);
    setPayCycleStatus(undefined);
    try {
      await setPayCyclePlan(payCycleEnabled ? {
        paydayDay,
        defaultSavingsTargetMinor: goalMinor,
      } : undefined);
      setPayCycleStatus(payCycleEnabled ? "发薪周期已更新" : "发薪周期已关闭");
      onDataChanged();
    } catch {
      setPayCycleError("发薪周期没有保存，请重试");
    } finally {
      setSavingPayCycle(false);
    }
  };

  const saveInitialSavings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let amountMinor: number;
    try {
      amountMinor = parseSignedAmountToMinor(initialSavingsInput);
      if (amountMinor < 0) {
        setInitialSavingsError("初始留存不能小于 0");
        return;
      }
    } catch {
      setInitialSavingsError("初始留存请输入有效金额，最多保留两位小数");
      return;
    }

    setSavingInitialSavings(true);
    setInitialSavingsError(undefined);
    setInitialSavingsStatus(undefined);
    try {
      await setInitialSavings(amountMinor);
      setInitialSavingsStatus(amountMinor === 0 ? "初始留存已清除" : "初始留存已更新");
      onDataChanged();
    } catch (reason) {
      setInitialSavingsError(
        reason instanceof Error ? reason.message : "初始留存没有保存，请重试",
      );
    } finally {
      setSavingInitialSavings(false);
    }
  };

  const saveCycleOverride = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = cycleOverrideInput.trim();
    let targetMinor: number | undefined;
    if (normalized) {
      try {
        targetMinor = parseSignedAmountToMinor(normalized);
        if (targetMinor < 0) {
          setCycleOverrideError("本周期目标不能小于 0");
          return;
        }
      } catch {
        setCycleOverrideError("本周期目标请输入有效金额，最多保留两位小数");
        return;
      }
    }

    setSavingCycleOverride(true);
    setCycleOverrideError(undefined);
    setCycleOverrideStatus(undefined);
    try {
      await setSavingsTargetOverride(targetMinor);
      setCycleOverrideStatus(
        targetMinor === undefined ? "本周期改用默认目标" : "本周期目标已更新",
      );
      onDataChanged();
    } catch (reason) {
      setCycleOverrideError(
        reason instanceof Error ? reason.message : "本周期目标没有保存，请重试",
      );
    } finally {
      setSavingCycleOverride(false);
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
          <form className="inline-setting-form settings-subform" onSubmit={(event) => void saveInitialSavings(event)} noValidate>
            <div className="field-group compact-field">
              <label htmlFor="initial-savings">初始留存</label>
              <div className="signed-input">
                <span aria-hidden="true">¥</span>
                <input
                  id="initial-savings"
                  value={initialSavingsInput}
                  inputMode="decimal"
                  aria-invalid={Boolean(initialSavingsError)}
                  aria-describedby={initialSavingsError ? "initial-savings-error initial-savings-help" : "initial-savings-help"}
                  onChange={(event) => {
                    setInitialSavingsInput(event.target.value);
                    setInitialSavingsError(undefined);
                    setInitialSavingsStatus(undefined);
                  }}
                />
              </div>
              <p id="initial-savings-help" className="field-help">已在总余额中、但不打算日常花掉的钱。</p>
              {initialSavingsError ? <p id="initial-savings-error" className="field-error" role="alert">{initialSavingsError}</p> : null}
            </div>
            <button type="submit" className="secondary-button" disabled={savingInitialSavings}>
              {savingInitialSavings ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              保存初始留存
            </button>
          </form>
          {initialSavingsStatus ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {initialSavingsStatus}</p> : null}
        </section>

        <section className="settings-section" aria-labelledby="pay-cycle-setting-title">
          <div className="settings-section-heading">
            <div className="settings-icon"><CalendarDays aria-hidden="true" /></div>
            <div>
              <h3 id="pay-cycle-setting-title">发薪周期</h3>
              <p>发薪日用于划分周期；收入到账后仍需确认记账。</p>
            </div>
          </div>
          <form className="goal-setting-form" onSubmit={(event) => void savePayCycle(event)} noValidate>
            <label className="setting-toggle">
              <input
                type="checkbox"
                role="switch"
                checked={payCycleEnabled}
                onChange={(event) => {
                  setPayCycleEnabled(event.target.checked);
                  setPaydayError(undefined);
                  setCycleGoalError(undefined);
                  setPayCycleError(undefined);
                  setPayCycleStatus(undefined);
                }}
              />
              <span className="toggle-control" aria-hidden="true"><span /></span>
              <span>
                <strong>打开发薪周期</strong>
                <small>查看到发薪日的余额判断和每日可花金额</small>
              </span>
            </label>
            <div className="pay-cycle-fields">
              <div className="field-group compact-field">
                <label htmlFor="payday-day">每月发薪日</label>
                <div className="unit-input">
                  <input
                    id="payday-day"
                    value={paydayInput}
                    inputMode="numeric"
                    disabled={!payCycleEnabled}
                    aria-invalid={Boolean(paydayError)}
                    aria-describedby={paydayError ? "payday-day-error" : undefined}
                    onChange={(event) => {
                      setPaydayInput(event.target.value);
                      setPaydayError(undefined);
                      setPayCycleError(undefined);
                      setPayCycleStatus(undefined);
                    }}
                  />
                  <span>日</span>
                </div>
                {paydayError ? <p id="payday-day-error" className="field-error" role="alert">{paydayError}</p> : null}
              </div>
              <div className="field-group compact-field">
                <label htmlFor="default-savings-target">每周期默认留存目标</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="default-savings-target"
                    value={cycleGoalInput}
                    inputMode="decimal"
                    disabled={!payCycleEnabled}
                    aria-invalid={Boolean(cycleGoalError)}
                    aria-describedby={cycleGoalError ? "default-savings-target-error default-savings-target-help" : "default-savings-target-help"}
                    onChange={(event) => {
                      setCycleGoalInput(event.target.value);
                      setCycleGoalError(undefined);
                      setPayCycleError(undefined);
                      setPayCycleStatus(undefined);
                    }}
                  />
                </div>
                <p id="default-savings-target-help" className="field-help">每个周期希望新增留存的钱。</p>
                {cycleGoalError ? <p id="default-savings-target-error" className="field-error" role="alert">{cycleGoalError}</p> : null}
              </div>
              <div className="pay-cycle-actions">
                <button type="submit" className="secondary-button" disabled={savingPayCycle}>
                  {savingPayCycle ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                  保存发薪周期
                </button>
                {payCycleError ? <p id="pay-cycle-error" className="field-error" role="alert">{payCycleError}</p> : null}
              </div>
            </div>
          </form>
          {payCycleStatus ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {payCycleStatus}</p> : null}
          {settings?.savingsTargetNeedsReview ? (
            <p className="field-warning" role="status">
              旧版周期底线已转换为留存目标，请确认默认金额是否符合现在的计划。
            </p>
          ) : null}
          {settings?.payCycle ? (
            <form className="inline-setting-form settings-subform" onSubmit={(event) => void saveCycleOverride(event)} noValidate>
              <div className="field-group compact-field">
                <label htmlFor="cycle-savings-target">本周期留存目标（可选）</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="cycle-savings-target"
                    value={cycleOverrideInput}
                    inputMode="decimal"
                    placeholder={signedInput(savingsTargetFromPlan(settings.payCycle))}
                    aria-invalid={Boolean(cycleOverrideError)}
                    aria-describedby={cycleOverrideError ? "cycle-savings-target-error cycle-savings-target-help" : "cycle-savings-target-help"}
                    onChange={(event) => {
                      setCycleOverrideInput(event.target.value);
                      setCycleOverrideError(undefined);
                      setCycleOverrideStatus(undefined);
                    }}
                  />
                </div>
                <p id="cycle-savings-target-help" className="field-help">
                  留空使用默认目标{settings.incomeForecast ? `；本次绑定 ${readableDateKey(settings.incomeForecast.targetPaydayDateKey)}` : ""}。
                </p>
                {cycleOverrideError ? <p id="cycle-savings-target-error" className="field-error" role="alert">{cycleOverrideError}</p> : null}
              </div>
              <button type="submit" className="secondary-button" disabled={savingCycleOverride}>
                {savingCycleOverride ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
                保存本周期目标
              </button>
            </form>
          ) : null}
          {cycleOverrideStatus ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {cycleOverrideStatus}</p> : null}
          {settings?.payCycle ? (
            <div className="income-setting-row">
              <div>
                <span><TrendingUp aria-hidden="true" /> 下次收入</span>
                {settings?.incomeForecast ? (
                  <strong>
                    {readableDateKey(settings.incomeForecast.targetPaydayDateKey)} · 最低 {formatCny(settings.incomeForecast.minimumIncomeMinor)} · 预计 {formatCny(settings.incomeForecast.expectedIncomeMinor)}
                  </strong>
                ) : <strong>尚未填写</strong>}
              </div>
              <button type="button" className="secondary-button" onClick={onOpenIncomeForecast}>
                {settings?.incomeForecast ? "修改收入预期" : "填写下次收入"}
              </button>
            </div>
          ) : null}
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
                    <div><dt>发薪日</dt><dd>{prepared.preview.payCycle ? `每月 ${prepared.preview.payCycle.paydayDay} 日` : "未设置"}</dd></div>
                    <div><dt>默认留存目标</dt><dd>{prepared.preview.payCycle ? formatCny(savingsTargetFromPlan(prepared.preview.payCycle)) : prepared.preview.monthEndBalanceGoalMinor === undefined ? "未设置" : `${formatCny(Math.max(prepared.preview.monthEndBalanceGoalMinor, 0))}（旧版转换）`}</dd></div>
                    <div><dt>本周期目标</dt><dd>{prepared.preview.savingsTargetOverride ? formatCny(prepared.preview.savingsTargetOverride.targetMinor) : "使用默认目标"}</dd></div>
                    <div><dt>留存记录</dt><dd>{prepared.preview.savingsEventCount ?? 0} 条</dd></div>
                    <div><dt>预计到账日</dt><dd>{prepared.preview.incomeForecast?.targetPaydayDateKey ?? "未设置"}</dd></div>
                    <div><dt>最低收入</dt><dd>{prepared.preview.incomeForecast ? formatCny(prepared.preview.incomeForecast.minimumIncomeMinor) : "未设置"}</dd></div>
                    <div><dt>预计收入</dt><dd>{prepared.preview.incomeForecast ? formatCny(prepared.preview.incomeForecast.expectedIncomeMinor) : "未设置"}</dd></div>
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
