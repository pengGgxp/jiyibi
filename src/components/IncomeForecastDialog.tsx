import { CalendarClock, CircleAlert, LoaderCircle, Save, WalletCards } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { recordActualIncome, setIncomeForecast } from "../data";
import {
  addLocalDays,
  amountMinorToInput,
  currentLocalDateKey,
  localDateFromKey,
  parseSignedAmountToMinor,
  resolveFollowingPaydayDateKey,
  resolvePayCycleRange,
  type AppSettings,
} from "../domain";
import { Modal } from "./Modal";

export type IncomeDialogMode = "forecast" | "actual";

interface IncomeForecastDialogProps {
  open: boolean;
  mode: IncomeDialogMode;
  settings?: AppSettings;
  onClose(): void;
  onSaved(message: string): void;
}

type IncomeField = "targetDate" | "expected" | "actual" | "form";

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
  onClose,
  onSaved,
}: IncomeForecastDialogProps) {
  const [expectedInput, setExpectedInput] = useState("0.00");
  const [actualInput, setActualInput] = useState("0.00");
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
    const expectedMinor = existing?.expectedIncomeMinor
      ?? settings?.lastExpectedIncomeMinor
      ?? 0;
    setExpectedInput(amountMinorToInput(expectedMinor));
    setActualInput(amountMinorToInput(existing?.expectedIncomeMinor ?? 0));
  }, [existing, initialTargetDateKey, open, settings?.lastExpectedIncomeMinor]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plan) {
      setError({ field: "form", message: "请先设置发薪日" });
      return;
    }
    if (!targetDateKey) {
      setError({ field: "targetDate", message: "请选择到账日" });
      return;
    }
    try {
      localDateFromKey(targetDateKey);
    } catch {
      setError({ field: "targetDate", message: "日期无效" });
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
        message: `到账日请选择 ${targetDateMinimum} 至 ${targetDateMaximum}`,
      });
      return;
    }

    setError(undefined);
    setSaving(true);
    try {
      if (mode === "actual") {
        let actualMinor: number;
        try {
          actualMinor = parseNonNegativeAmount(actualInput, "实际额");
        } catch (reason) {
          setError({
            field: "actual",
            message: reason instanceof Error ? reason.message : "金额无效",
          });
          return;
        }
        await recordActualIncome(actualMinor);
        onSaved(actualMinor === 0 ? "本次收入已确认" : "收入已记账");
      } else {
        let expectedIncomeMinor: number;
        try {
          expectedIncomeMinor = parseNonNegativeAmount(expectedInput, "预计额");
        } catch (reason) {
          setError({
            field: "expected",
            message: reason instanceof Error ? reason.message : "金额无效",
          });
          return;
        }
        await setIncomeForecast({
          targetPaydayDateKey: targetDateKey,
          expectedIncomeMinor,
        });
        onSaved("预计收入已保存");
      }
      onClose();
    } catch (reason) {
      setError({
        field: "form",
        message: reason instanceof Error ? reason.message : "保存失败，请重试",
      });
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "actual" ? "实际收入" : "下次收入";
  const description = mode === "actual"
    ? `${targetDateKey ? readableDate(targetDateKey) : "本次到账日"}的实际到账金额。`
    : "只用于这次估算，不会提前计入余额。";

  return (
    <Modal open={open} title={title} description={description} onClose={onClose}>
      {!plan || !targetDateKey ? (
        <div className="income-dialog-state" role="alert">
          <CircleAlert aria-hidden="true" />
          <p>请先设置发薪日。</p>
        </div>
      ) : (
        <form className="income-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
          {mode === "forecast" ? (
            <div className="income-target-date income-target-date--editable">
              <CalendarClock aria-hidden="true" />
              <label htmlFor="income-target-date">
                <small>到账日</small>
                <span>可单次延期</span>
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
              <p id="income-target-date-help">只改这一次</p>
            </div>
          ) : (
            <div className="income-target-date">
              <CalendarClock aria-hidden="true" />
              <span><small>到账日</small><strong>{readableDate(targetDateKey)}</strong></span>
            </div>
          )}

          {mode === "forecast" ? (
            <div className="income-dialog-fields">
              <div className="field-group">
                <label htmlFor="expected-income">预计额</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="expected-income"
                    data-autofocus
                    inputMode="decimal"
                    value={expectedInput}
                    aria-invalid={error?.field === "expected"}
                    aria-describedby={error?.field === "expected" ? "income-dialog-error income-dialog-help" : "income-dialog-help"}
                    onChange={(event) => { setExpectedInput(event.target.value); setError(undefined); }}
                  />
                </div>
              </div>
              <p id="income-dialog-help" className="field-help">不会自动记账</p>
            </div>
          ) : (
            <div className="income-settlement-fields">
              <div className="field-group income-actual-field">
                <label htmlFor="actual-income">实际额</label>
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
                <p id="actual-income-help" className="field-help">填 0 不生成账目</p>
              </div>
            </div>
          )}

          {error ? <p id="income-dialog-error" className="field-error" role="alert">{error.message}</p> : null}

          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : mode === "actual" ? <WalletCards aria-hidden="true" /> : <Save aria-hidden="true" />}
              {saving ? "保存中" : mode === "actual" ? "确认收入" : "保存预计"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
