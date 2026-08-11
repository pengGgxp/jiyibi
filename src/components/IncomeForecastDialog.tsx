import { CalendarClock, CircleAlert, LoaderCircle, Save, WalletCards } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { recordActualIncome, setIncomeForecast } from "../data";
import {
  amountMinorToInput,
  localDateFromKey,
  parseSignedAmountToMinor,
  resolveNextPaydayDateKey,
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

function parseNonNegativeAmount(input: string): number {
  const value = parseSignedAmountToMinor(input);
  if (value < 0) throw new Error("收入不能小于 0");
  return value;
}

export function IncomeForecastDialog({
  open,
  mode,
  settings,
  onClose,
  onSaved,
}: IncomeForecastDialogProps) {
  const [minimumInput, setMinimumInput] = useState("0.00");
  const [expectedInput, setExpectedInput] = useState("0.00");
  const [actualInput, setActualInput] = useState("0.00");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const initialized = useRef(false);
  const plan = settings?.payCycle;
  const existing = settings?.incomeForecast;
  const targetDateKey = mode === "actual"
    ? existing?.targetPaydayDateKey
    : plan
      ? resolveNextPaydayDateKey(plan.paydayDay)
      : undefined;
  const reusableForecast = mode === "forecast" && existing?.targetPaydayDateKey === targetDateKey
    ? existing
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
    setMinimumInput(amountMinorToInput(reusableForecast?.minimumIncomeMinor ?? 0));
    setExpectedInput(amountMinorToInput(reusableForecast?.expectedIncomeMinor ?? 0));
    setActualInput(amountMinorToInput(existing?.expectedIncomeMinor ?? 0));
  }, [existing, mode, open, reusableForecast, targetDateKey]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plan || !targetDateKey) {
      setError("请先设置发薪日和周期底线");
      return;
    }

    setError(undefined);
    setSaving(true);
    try {
      if (mode === "actual") {
        const actualMinor = parseNonNegativeAmount(actualInput);
        await recordActualIncome(actualMinor);
        onSaved(actualMinor === 0 ? "本次收入已确认为 ¥0.00" : "实际收入已记入余额");
      } else {
        const minimumIncomeMinor = parseNonNegativeAmount(minimumInput);
        const expectedIncomeMinor = parseNonNegativeAmount(expectedInput);
        if (minimumIncomeMinor > expectedIncomeMinor) {
          throw new Error("最低收入不能高于预计收入");
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
      setError(reason instanceof Error ? reason.message : "收入没有保存，请重试");
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
          <p>请先在设置中填写发薪日和周期底线。</p>
        </div>
      ) : (
        <form className="income-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
          <div className="income-target-date">
            <CalendarClock aria-hidden="true" />
            <span><small>目标发薪日</small><strong>{readableDate(targetDateKey)}</strong></span>
          </div>

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
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "income-dialog-error" : "income-dialog-help"}
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
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "income-dialog-error" : "income-dialog-help"}
                    onChange={(event) => { setExpectedInput(event.target.value); setError(undefined); }}
                  />
                </div>
              </div>
              <p id="income-dialog-help" className="field-help">最低收入可以填 0；两个金额都不会提前计入余额。</p>
            </div>
          ) : (
            <div className="field-group income-actual-field">
              <label htmlFor="actual-income">实际到账总额</label>
              <div className="signed-input">
                <span aria-hidden="true">¥</span>
                <input
                  id="actual-income"
                  data-autofocus
                  inputMode="decimal"
                  value={actualInput}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "income-dialog-error" : "actual-income-help"}
                  onChange={(event) => { setActualInput(event.target.value); setError(undefined); }}
                />
              </div>
              <p id="actual-income-help" className="field-help">填 0 表示本次没有收入，不会生成零金额账目。</p>
            </div>
          )}

          {error ? <p id="income-dialog-error" className="field-error" role="alert">{error}</p> : null}

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
