import { CheckCircle2, History, LoaderCircle, Scale, Save } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  correctOpeningBalance,
  LedgerDataError,
  reconcileBalance,
  setInitialBalance,
} from "../data";
import {
  formatCny,
  parseSignedAmountToMinor,
  type BalanceAdjustment,
} from "../domain";
import { Modal } from "./Modal";

export type BalanceEditorMode = "initial" | "reconciliation" | "opening_correction";

interface BalanceAdjustmentDialogProps {
  open: boolean;
  mode?: BalanceEditorMode;
  currentBalanceMinor: number;
  initialBalanceMinor: number;
  locked: boolean;
  adjustments: readonly BalanceAdjustment[];
  onClose(): void;
  onSaved(adjustment?: BalanceAdjustment): void;
}

function inputAmount(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function effectiveOpeningMinor(
  initialBalanceMinor: number,
  adjustments: readonly BalanceAdjustment[],
): number {
  return adjustments.reduce((total, adjustment) =>
    !adjustment.deletedAt && adjustment.kind === "opening_correction"
      ? total + adjustment.amountMinor
      : total, initialBalanceMinor);
}

function signedDifference(minor: bigint): string {
  if (minor === 0n) return "一致";
  return `${minor > 0n ? "+" : ""}${formatCny(minor)}`;
}

export function BalanceAdjustmentDialog({
  open,
  mode,
  currentBalanceMinor,
  initialBalanceMinor,
  locked,
  adjustments,
  onClose,
  onSaved,
}: BalanceAdjustmentDialogProps) {
  const defaultMode = locked ? (mode === "opening_correction" ? mode : "reconciliation") : "initial";
  const [activeMode, setActiveMode] = useState<BalanceEditorMode>(defaultMode);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const openingMinor = useMemo(
    () => effectiveOpeningMinor(initialBalanceMinor, adjustments),
    [adjustments, initialBalanceMinor],
  );

  useEffect(() => {
    if (!open) return;
    const nextMode = locked ? (mode === "opening_correction" ? mode : "reconciliation") : "initial";
    setActiveMode(nextMode);
    setValue(inputAmount(nextMode === "reconciliation" ? currentBalanceMinor : openingMinor));
    setNote("");
    setError(undefined);
    setStatus(undefined);
  }, [currentBalanceMinor, locked, mode, open, openingMinor]);

  const targetMinor = (() => {
    try { return parseSignedAmountToMinor(value); } catch { return undefined; }
  })();
  const beforeMinor = activeMode === "reconciliation" ? currentBalanceMinor : openingMinor;
  const differenceMinor = targetMinor === undefined
    ? undefined
    : BigInt(targetMinor) - BigInt(beforeMinor);

  const selectMode = (next: BalanceEditorMode) => {
    setActiveMode(next);
    setValue(inputAmount(next === "reconciliation" ? currentBalanceMinor : openingMinor));
    setError(undefined);
    setStatus(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let target: number;
    try {
      target = parseSignedAmountToMinor(value);
      setError(undefined);
    } catch {
      setError("金额无效");
      return;
    }
    setBusy(true);
    setStatus(undefined);
    try {
      if (activeMode === "initial") {
        await setInitialBalance(target);
        setStatus("起点已保存");
        onSaved();
      } else {
        const adjustment = activeMode === "reconciliation"
          ? await reconcileBalance({ observedBalanceMinor: target, note })
          : await correctOpeningBalance({ nextOpeningMinor: target, note });
        setStatus(activeMode === "reconciliation" ? "余额已校准" : "起点已更正");
        onSaved(adjustment);
      }
    } catch (reason) {
      if (reason instanceof LedgerDataError && reason.code === "no-change") {
        setStatus("当前已一致");
      } else if (reason instanceof LedgerDataError && reason.code === "initial-balance-locked") {
        setError("起点已锁定，请使用更正起点");
        setActiveMode("opening_correction");
      } else {
        setError(reason instanceof Error ? reason.message : "保存失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const title = activeMode === "initial"
    ? "设置余额"
    : activeMode === "reconciliation" ? "校准余额" : "更正起点";
  const description = activeMode === "initial"
    ? "第一笔记录后将锁定。"
    : activeMode === "reconciliation"
      ? "输入全部个人可用资金的实际总额。"
      : "会改变整本账的起点，并保留更正记录。";

  return (
    <Modal open={open} title={title} description={description} onClose={onClose}>
      <div className="balance-adjustment-dialog">
        {locked ? (
          <div className="balance-mode-switch" role="group" aria-label="余额调整方式">
            <button type="button" className={activeMode === "reconciliation" ? "is-active" : ""} onClick={() => selectMode("reconciliation")}>
              <Scale aria-hidden="true" /> 校准余额
            </button>
            <button type="button" className={activeMode === "opening_correction" ? "is-active" : ""} onClick={() => selectMode("opening_correction")}>
              <History aria-hidden="true" /> 更正起点
            </button>
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)} noValidate>
          {activeMode === "opening_correction" ? (
            <dl className="balance-impact balance-impact--opening">
              <div><dt>原始起点</dt><dd>{formatCny(initialBalanceMinor)}</dd></div>
              <div><dt>当前起点</dt><dd>{formatCny(openingMinor)}</dd></div>
              <div><dt>新起点</dt><dd>{targetMinor === undefined ? "—" : formatCny(targetMinor)}</dd></div>
              <div><dt>历史影响</dt><dd>{differenceMinor === undefined ? "—" : signedDifference(differenceMinor)}</dd></div>
            </dl>
          ) : (
            <dl className="balance-impact">
              <div><dt>{activeMode === "reconciliation" ? "当前总额" : "当前起点"}</dt><dd>{formatCny(beforeMinor)}</dd></div>
              <div><dt>调整后</dt><dd>{targetMinor === undefined ? "—" : formatCny(targetMinor)}</dd></div>
              <div><dt>差额</dt><dd>{differenceMinor === undefined ? "—" : signedDifference(differenceMinor)}</dd></div>
            </dl>
          )}
          <div className="field-group">
            <label htmlFor="balance-adjustment-value">{activeMode === "reconciliation" ? "实际总额" : "新起点"}</label>
            <div className="signed-input"><span aria-hidden="true">¥</span><input id="balance-adjustment-value" data-autofocus value={value} inputMode="decimal" aria-invalid={Boolean(error)} aria-describedby={error ? "balance-adjustment-error" : undefined} onChange={(event) => { setValue(event.target.value); setError(undefined); setStatus(undefined); }} /></div>
          </div>
          {activeMode !== "initial" ? (
            <div className="field-group">
              <label htmlFor="balance-adjustment-note">说明</label>
              <input id="balance-adjustment-note" value={note} maxLength={200} placeholder="可选" onChange={(event) => setNote(event.target.value)} />
            </div>
          ) : null}
          {error ? <p id="balance-adjustment-error" className="form-error" role="alert">{error}</p> : null}
          {status ? <p className="success-status" role="status"><CheckCircle2 aria-hidden="true" /> {status}</p> : null}
          <div className="dialog-actions">
            <button type="button" className="text-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {busy ? "保存中" : "确认"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
