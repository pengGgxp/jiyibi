import { CalendarClock, CircleAlert, LoaderCircle, Save, WalletCards } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { recordActualIncomeWithSavings, setIncomeForecast } from "../data";
import {
  addLocalDays,
  amountMinorToInput,
  currentLocalDateKey,
  formatCny,
  localDateFromKey,
  parseSignedAmountToMinor,
  resolveFollowingPaydayDateKey,
  resolvePayCycleRange,
  type AppSettings,
  type SpendingAnalysis,
} from "../domain";
import { Modal } from "./Modal";

export type IncomeDialogMode = "forecast" | "actual";

export interface IncomeSettlementContext {
  targetMinor: number;
  netGrowthMinor: bigint;
  remainingTargetMinor: bigint;
  availableBeforeIncomeMinor: bigint;
  suggestedAmountMinor: number;
}

interface IncomeForecastDialogProps {
  open: boolean;
  mode: IncomeDialogMode;
  settings?: AppSettings;
  analysis?: SpendingAnalysis;
  settlement?: IncomeSettlementContext;
  onClose(): void;
  onSaved(message: string): void;
}

type IncomeField = "targetDate" | "minimum" | "expected" | "actual" | "savings" | "form";

interface IncomeFormError {
  field: IncomeField;
  message: string;
}

function readableDate(dateKey: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }).format(localDateFromKey(dateKey));
  } catch {
    return dateKey;
  }
}

function parseNonNegativeAmount(input: string, label: string): number {
  const value = parseSignedAmountToMinor(input);
  if (value < 0) throw new Error(`${label}不能小于 0`);
  return value;
}

export function IncomeForecastDialog({
  open,
  mode,
  settings,
  analysis,
  settlement,
  onClose,
  onSaved,
}: IncomeForecastDialogProps) {
  const [minimumInput, setMinimumInput] = useState("0.00");
  const [expectedInput, setExpectedInput] = useState("0.00");
  const [actualInput, setActualInput] = useState("0.00");
  const [savingsInput, setSavingsInput] = useState("0.00");
  const [targetDateInput, setTargetDateInput] = useState("");
  const [error, setError] = useState<IncomeFormError>();
  const [saving, setSaving] = useState(false);
  const initialized = useRef(false);
  const plan = settings?.payCycle;
  const existing = settings?.incomeForecast;
  const todayDateKey = currentLocalDateKey();
  const initialTargetDateKey = mode === "actual"
    ? existing?.targetPaydayDateKey
    : existing?.targetPaydayDateKey ?? (plan
      ? resolveFollowingPaydayDateKey(plan.paydayDay)
      : undefined);
  const targetDateKey = mode === "actual" ? initialTargetDateKey : targetDateInput;
  const targetDateMaximum = plan && initialTargetDateKey
    ? addLocalDays(
      resolvePayCycleRange(
        plan.paydayDay,
        localDateFromKey(initialTargetDateKey),
      ).nextPaydayDateKey,
      -1,
    )
    : undefined;
  const targetDateMinimum = plan
    ? (() => {
      if (existing) {
        const existingWindow = resolvePayCycleRange(
          plan.paydayDay,
          localDateFromKey(existing.targetPaydayDateKey),
        );
        return todayDateKey > existingWindow.cycleStartDateKey
          ? todayDateKey
          : existingWindow.cycleStartDateKey;
      }
      return todayDateKey;
    })()
    : undefined;

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      setError(undefined);
      setSaving(false);
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    setTargetDateInput(initialTargetDateKey ?? "");
    setMinimumInput(amountMinorToInput(existing?.minimumIncomeMinor ?? 0));
    setExpectedInput(amountMinorToInput(existing?.expectedIncomeMinor ?? 0));
    setActualInput(amountMinorToInput(existing?.expectedIncomeMinor ?? 0));
    if (settlement) {
      setSavingsInput(amountMinorToInput(settlement.suggestedAmountMinor));
    } else {
      const remaining = analysis?.currentCycle.remainingSavingsTargetMinor ?? 0n;
      const unretainedAfterExpected =
        (analysis?.currentCycle.totalBalanceMinor ?? 0n)
        + BigInt(existing?.expectedIncomeMinor ?? 0)
        - (analysis?.currentCycle.retainedBalanceMinor ?? 0n);
      const defaultSavings = remaining < unretainedAfterExpected ? remaining : unretainedAfterExpected;
      setSavingsInput(amountMinorToInput(Number(defaultSavings > 0n ? defaultSavings : 0n)));
    }
  }, [analysis, existing, initialTargetDateKey, open, settlement]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plan) {
      setError({ field: "form", message: "请先设置发薪日和每周期默认留存目标" });
      return;
    }
    if (!targetDateKey) {
      setError({ field: "targetDate", message: "请选择本次预计到账日" });
      return;
    }
    try {
      localDateFromKey(targetDateKey);
    } catch {
      setError({ field: "targetDate", message: "请选择有效的预计到账日" });
      return;
    }
    if (
      mode === "forecast" &&
      (
        (targetDateMinimum !== undefined && targetDateKey < targetDateMinimum) ||
        (targetDateMaximum !== undefined && targetDateKey > targetDateMaximum)
      )
    ) {
      setError({
        field: "targetDate",
        message: `预计到账日请选择 ${targetDateMinimum} 至 ${targetDateMaximum} 之间的日期`,
      });
      return;
    }

    setError(undefined);
    setSaving(true);
    try {
      if (mode === "actual") {
        let actualMinor: number;
        let savingsAmountMinor: number;
        try {
          actualMinor = parseNonNegativeAmount(actualInput, "实际收入");
        } catch (reason) {
          setError({
            field: "actual",
            message: reason instanceof Error ? reason.message : "实际收入格式无效",
          });
          return;
        }
        try {
          savingsAmountMinor = parseNonNegativeAmount(savingsInput, "留存金额");
        } catch (reason) {
          setError({
            field: "savings",
            message: reason instanceof Error ? reason.message : "留存金额格式无效",
          });
          return;
        }
        if (
          settlement
          && BigInt(savingsAmountMinor) > settlement.availableBeforeIncomeMinor + BigInt(actualMinor)
        ) {
          setError({ field: "savings", message: "本次留存不能超过到账后的未留存资金" });
          return;
        }
        await recordActualIncomeWithSavings(actualMinor, savingsAmountMinor);
        onSaved(actualMinor === 0 ? "本次收入已确认为 ¥0.00" : "实际收入已记入余额");
      } else {
        let minimumIncomeMinor: number;
        let expectedIncomeMinor: number;
        try {
          minimumIncomeMinor = parseNonNegativeAmount(minimumInput, "最低收入");
        } catch (reason) {
          setError({
            field: "minimum",
            message: reason instanceof Error ? reason.message : "最低收入格式无效",
          });
          return;
        }
        try {
          expectedIncomeMinor = parseNonNegativeAmount(expectedInput, "预计收入");
        } catch (reason) {
          setError({
            field: "expected",
            message: reason instanceof Error ? reason.message : "预计收入格式无效",
          });
          return;
        }
        if (minimumIncomeMinor > expectedIncomeMinor) {
          setError({ field: "minimum", message: "最低收入不能高于预计收入" });
          return;
        }
        await setIncomeForecast({
          targetPaydayDateKey: targetDateKey,
          minimumIncomeMinor,
          expectedIncomeMinor,
        });
        onSaved("下次收入预期已保存");
      }
      onClose();
    } catch (reason) {
      setError({
        field: "form",
        message: reason instanceof Error ? reason.message : "收入没有保存，请重试",
      });
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "actual" ? "填写实际收入" : "填写下次收入";
  const description = mode === "actual"
    ? `${targetDateKey ? readableDate(targetDateKey) : "本次发薪日"}的实际到账总额。确认后会直接记入余额。`
    : "只用于这次估算，不会自动记入余额，也不会沿用到下个周期。";

  return (
    <Modal open={open} title={title} description={description} onClose={onClose}>
      {!plan || !targetDateKey ? (
        <div className="income-dialog-state" role="alert">
          <CircleAlert aria-hidden="true" />
          <p>请先在设置中填写发薪日和每周期默认留存目标。</p>
        </div>
      ) : (
        <form className="income-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
          {mode === "forecast" ? (
            <div className="income-target-date income-target-date--editable">
              <CalendarClock aria-hidden="true" />
              <label htmlFor="income-target-date">
                <small>本次预计到账日</small>
                <span>默认按每月发薪日，可单独延后</span>
              </label>
              <input
                id="income-target-date"
                type="date"
                value={targetDateInput}
                min={targetDateMinimum}
                max={targetDateMaximum}
                aria-invalid={error?.field === "targetDate"}
                aria-describedby={error?.field === "targetDate" ? "income-dialog-error income-target-date-help" : "income-target-date-help"}
                onChange={(event) => { setTargetDateInput(event.target.value); setError(undefined); }}
              />
              <p id="income-target-date-help">只调整这一次，每月默认发薪日不变。</p>
            </div>
          ) : (
            <div className="income-target-date">
              <CalendarClock aria-hidden="true" />
              <span><small>本次预计到账日</small><strong>{readableDate(targetDateKey)}</strong></span>
            </div>
          )}

          {mode === "forecast" ? (
            <div className="income-dialog-fields">
              <div className="field-group">
                <label htmlFor="minimum-income">最低收入</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="minimum-income"
                    data-autofocus
                    inputMode="decimal"
                    value={minimumInput}
                    aria-invalid={error?.field === "minimum"}
                    aria-describedby={error?.field === "minimum" ? "income-dialog-error income-dialog-help" : "income-dialog-help"}
                    onChange={(event) => { setMinimumInput(event.target.value); setError(undefined); }}
                  />
                </div>
              </div>
              <div className="field-group">
                <label htmlFor="expected-income">预计收入</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="expected-income"
                    inputMode="decimal"
                    value={expectedInput}
                    aria-invalid={error?.field === "expected"}
                    aria-describedby={error?.field === "expected" ? "income-dialog-error income-dialog-help" : "income-dialog-help"}
                    onChange={(event) => { setExpectedInput(event.target.value); setError(undefined); }}
                  />
                </div>
              </div>
              <p id="income-dialog-help" className="field-help">最低收入可以填 0；两个金额都不会提前计入余额。</p>
            </div>
          ) : (
            <div className="income-settlement-fields">
              <dl className="income-settlement-summary">
                <div><dt>本周期目标</dt><dd>{formatCny(settlement?.targetMinor ?? analysis?.currentCycle.savingsTargetMinor ?? 0)}</dd></div>
                <div><dt>当前净增长</dt><dd>{formatCny(settlement?.netGrowthMinor ?? analysis?.currentCycle.cycleNetGrowthMinor ?? 0n)}</dd></div>
                <div><dt>尚需留存</dt><dd>{formatCny(settlement?.remainingTargetMinor ?? analysis?.currentCycle.remainingSavingsTargetMinor ?? 0n)}</dd></div>
              </dl>
              <div className="field-group income-actual-field">
                <label htmlFor="actual-income">实际到账总额</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="actual-income"
                    data-autofocus
                    inputMode="decimal"
                    value={actualInput}
                    aria-invalid={error?.field === "actual"}
                    aria-describedby={error?.field === "actual" ? "income-dialog-error actual-income-help" : "actual-income-help"}
                    onChange={(event) => { setActualInput(event.target.value); setError(undefined); }}
                  />
                </div>
                <p id="actual-income-help" className="field-help">填 0 表示本次没有收入，不会生成零金额账目。</p>
              </div>
              <div className="field-group income-actual-field">
                <label htmlFor="settlement-savings">本次再留存</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="settlement-savings"
                    inputMode="decimal"
                    value={savingsInput}
                    aria-invalid={error?.field === "savings"}
                    aria-describedby={error?.field === "savings" ? "income-dialog-error settlement-savings-help" : "settlement-savings-help"}
                    onChange={(event) => { setSavingsInput(event.target.value); setError(undefined); }}
                  />
                </div>
                <p id="settlement-savings-help" className="field-help">可填 0 或超过目标；留存不会被记为支出。</p>
              </div>
            </div>
          )}

          {error ? <p id="income-dialog-error" className="field-error" role="alert">{error.message}</p> : null}

          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : mode === "actual" ? <WalletCards aria-hidden="true" /> : <Save aria-hidden="true" />}
              {saving ? "正在保存" : mode === "actual" ? "记入实际收入" : "保存收入预期"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
