import {
  CalendarClock,
  CircleAlert,
  LoaderCircle,
  Save,
  WalletCards,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  postponeIncomeForecast,
  recordActualIncomeOnDate,
  replaceIncomeForecast,
  setIncomeForecastIfUnchanged,
} from "../data";
import {
  addLocalDays,
  amountMinorToInput,
  currentLocalDateKey,
  formatCny,
  localDateFromKey,
  parseSignedAmountToMinor,
  resolveIncomeForecastDateWindow,
  resolveIncomeForecastPostponeWindow,
  type AppSettings,
  type IncomeForecast,
  type PayCyclePlan,
} from "../domain";
import { Modal } from "./Modal";

export type IncomeDialogMode = "forecast" | "postpone" | "actual";

interface IncomeForecastDialogProps {
  open: boolean;
  mode: IncomeDialogMode;
  settings?: AppSettings;
  onClose(): void;
  onModeChange?(mode: IncomeDialogMode): void;
  onSaved(message: string): void;
}

type IncomeField = "targetDate" | "expected" | "actual" | "form";
type DateChoice = "regular" | "custom";

interface IncomeFormError {
  field: IncomeField;
  message: string;
}

interface IncomeDialogSnapshot {
  openedAt: Date;
  payCycle?: PayCyclePlan;
  incomeForecast?: IncomeForecast;
  lastExpectedIncomeMinor?: number;
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
  onModeChange,
  onSaved,
}: IncomeForecastDialogProps) {
  const [expectedInput, setExpectedInput] = useState("0.00");
  const [actualInput, setActualInput] = useState("0.00");
  const [targetDateInput, setTargetDateInput] = useState("");
  const [dateChoice, setDateChoice] = useState<DateChoice>("regular");
  const [error, setError] = useState<IncomeFormError>();
  const [saving, setSaving] = useState(false);
  const initializedMode = useRef<IncomeDialogMode | undefined>(undefined);
  const snapshotRef = useRef<IncomeDialogSnapshot | undefined>(undefined);
  if (!open) snapshotRef.current = undefined;
  if (open && !snapshotRef.current && settings) {
    snapshotRef.current = {
      openedAt: new Date(),
      ...(settings.payCycle ? { payCycle: { ...settings.payCycle } } : {}),
      ...(settings.incomeForecast
        ? { incomeForecast: { ...settings.incomeForecast } }
        : {}),
      ...(settings.lastExpectedIncomeMinor === undefined
        ? {}
        : { lastExpectedIncomeMinor: settings.lastExpectedIncomeMinor }),
    };
  }
  const snapshot = snapshotRef.current;
  const plan = snapshot?.payCycle;
  const existing = snapshot?.incomeForecast;
  const openedAt = snapshot?.openedAt ?? new Date();
  const todayDateKey = currentLocalDateKey(openedAt);
  const dateWindow = plan
    ? resolveIncomeForecastDateWindow(plan.paydayDay, openedAt)
    : undefined;
  const postponeWindow = plan && existing
    ? resolveIncomeForecastPostponeWindow(
      plan.paydayDay,
      existing.targetPaydayDateKey,
      openedAt,
    )
    : undefined;
  const existingIsInWindow = Boolean(
    existing
    && dateWindow
    && existing.targetPaydayDateKey >= dateWindow.minimumDateKey
    && existing.targetPaydayDateKey <= dateWindow.maximumDateKey,
  );
  const existingIsDue = Boolean(
    existing && existing.targetPaydayDateKey <= todayDateKey,
  );
  const replaceDueForecast = mode === "forecast" && existingIsDue;

  let initialTargetDateKey: string | undefined;
  if (mode === "actual") {
    initialTargetDateKey = existing
      ? existing.targetPaydayDateKey <= todayDateKey
        ? todayDateKey
        : existing.targetPaydayDateKey
      : undefined;
  } else if (mode === "postpone") {
    if (existing?.targetPaydayDateKey && existing.targetPaydayDateKey > todayDateKey) {
      initialTargetDateKey = existing.targetPaydayDateKey;
    } else if (existing?.targetPaydayDateKey === todayDateKey && postponeWindow) {
      const tomorrowDateKey = addLocalDays(todayDateKey, 1);
      initialTargetDateKey = tomorrowDateKey <= postponeWindow.maximumDateKey
        ? tomorrowDateKey
        : todayDateKey;
    } else {
      initialTargetDateKey = dateWindow?.minimumDateKey;
    }
  } else if (
    existing
    && existingIsInWindow
    && existing.targetPaydayDateKey > todayDateKey
  ) {
    initialTargetDateKey = existing.targetPaydayDateKey;
  } else {
    initialTargetDateKey = dateWindow?.regularDateKey;
  }

  const targetDateKey = mode === "actual"
    ? targetDateInput
    : mode === "forecast" && dateChoice === "regular"
      ? dateWindow?.regularDateKey
      : targetDateInput;
  const targetDateMinimum = mode === "postpone"
    ? postponeWindow?.minimumDateKey
    : replaceDueForecast
      ? addLocalDays(todayDateKey, 1)
      : dateWindow?.minimumDateKey;
  const targetDateMaximum = mode === "postpone"
    ? postponeWindow?.maximumDateKey
    : dateWindow?.maximumDateKey;

  useEffect(() => {
    if (!open) {
      initializedMode.current = undefined;
      setError(undefined);
      setSaving(false);
      return;
    }
    if (initializedMode.current === mode) return;
    initializedMode.current = mode;
    setTargetDateInput(initialTargetDateKey ?? "");
    setDateChoice(
      mode === "forecast"
      && initialTargetDateKey !== undefined
      && initialTargetDateKey !== dateWindow?.regularDateKey
        ? "custom"
        : "regular",
    );
    const expectedMinor = existing?.expectedIncomeMinor
      ?? snapshot?.lastExpectedIncomeMinor
      ?? 0;
    setExpectedInput(amountMinorToInput(expectedMinor));
    setActualInput(amountMinorToInput(existing?.expectedIncomeMinor ?? 0));
  }, [
    dateWindow?.regularDateKey,
    existing?.expectedIncomeMinor,
    initialTargetDateKey,
    mode,
    open,
    snapshot?.lastExpectedIncomeMinor,
  ]);

  const validateTargetDate = (): boolean => {
    if (!targetDateKey) {
      setError({ field: "targetDate", message: "请选择到账日" });
      return false;
    }
    try {
      localDateFromKey(targetDateKey);
    } catch {
      setError({ field: "targetDate", message: "日期无效" });
      return false;
    }
    if (mode === "actual") {
      if (
        existing
        && (
          targetDateKey < existing.targetPaydayDateKey
          || targetDateKey > todayDateKey
        )
      ) {
        setError({
          field: "targetDate",
          message: `请选择 ${existing.targetPaydayDateKey} 至 ${todayDateKey}`,
        });
        return false;
      }
    } else if (
        (targetDateMinimum !== undefined && targetDateKey < targetDateMinimum)
        || (targetDateMaximum !== undefined && targetDateKey > targetDateMaximum)
    ) {
      setError({
        field: "targetDate",
        message: `请选择 ${targetDateMinimum} 至 ${targetDateMaximum}`,
      });
      return false;
    }
    return true;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!plan) {
      setError({ field: "form", message: "请先设置发薪日" });
      return;
    }
    if (!validateTargetDate()) return;

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
        if (!existing) {
          setError({ field: "form", message: "没有待确认收入" });
          return;
        }
        await recordActualIncomeOnDate(actualMinor, targetDateKey!, existing);
        onSaved(actualMinor === 0 ? "本次收入已确认" : "收入已记账");
      } else if (mode === "postpone") {
        if (!existing) {
          setError({ field: "form", message: "没有待延期收入" });
          return;
        }
        await postponeIncomeForecast(targetDateKey!, existing);
        onSaved("到账日已更新");
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
        const nextForecast = {
          targetPaydayDateKey: targetDateKey!,
          expectedIncomeMinor,
        };
        if (replaceDueForecast) {
          await replaceIncomeForecast(nextForecast, existing!);
        } else {
          await setIncomeForecastIfUnchanged(nextForecast, existing ?? null);
        }
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

  const title = mode === "actual"
    ? "实际收入"
    : mode === "postpone"
      ? "延期到账"
      : "下次收入";
  const description = mode === "actual"
    ? "确认实际到账日期和金额。"
    : mode === "postpone"
      ? "只改本次日期，不改每月发薪日。"
      : "只用于这次估算，不会提前计入余额。";
  const missingState = !plan
    ? "请先设置发薪日。"
    : mode !== "forecast" && !existing
      ? "没有待处理收入。"
      : mode === "postpone"
        && targetDateMinimum !== undefined
        && targetDateMaximum !== undefined
        && targetDateMinimum > targetDateMaximum
        ? "本次已跨期，请先确认收入。"
      : !targetDateKey
        ? "请选择到账日。"
        : undefined;

  const dateError = error?.field === "targetDate" ? error.message : undefined;
  const expectedError = error?.field === "expected" ? error.message : undefined;
  const actualError = error?.field === "actual" ? error.message : undefined;

  return (
    <Modal open={open} title={title} description={description} onClose={onClose}>
      {missingState ? (
        <>
          <div className="income-dialog-state" role="alert">
            <CircleAlert aria-hidden="true" />
            <p>{missingState}</p>
          </div>
          {mode === "postpone" && existing && plan && onModeChange ? (
            <div className="modal-actions income-dialog-state-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onModeChange("forecast")}
              >
                <CalendarClock aria-hidden="true" />
                设为下次
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => onModeChange("actual")}
              >
                <WalletCards aria-hidden="true" />
                确认收入
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <form className="income-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
          {replaceDueForecast && existing ? (
            <div className="income-forecast-stale" role="status">
              <CircleAlert aria-hidden="true" />
              <span>
                <strong>{existing.targetPaydayDateKey < todayDateKey ? "上次已过" : "今天到账"}</strong>
                <small>{readableDate(existing.targetPaydayDateKey)} · 设为下次将结束本次</small>
              </span>
            </div>
          ) : null}

          {mode === "forecast" ? (
            <fieldset className="income-date-choice">
              <legend>到账日</legend>
              <div className="income-date-options">
                <label className={dateChoice === "regular" ? "is-selected" : undefined}>
                  <input
                    type="radio"
                    name="income-date-choice"
                    value="regular"
                    checked={dateChoice === "regular"}
                    onChange={() => {
                      setDateChoice("regular");
                      setError(undefined);
                    }}
                  />
                  <span>
                    <strong>常规日</strong>
                    <small>{readableDate(dateWindow!.regularDateKey)}</small>
                  </span>
                </label>
                <label className={dateChoice === "custom" ? "is-selected" : undefined}>
                  <input
                    type="radio"
                    name="income-date-choice"
                    value="custom"
                    checked={dateChoice === "custom"}
                    onChange={() => {
                      setDateChoice("custom");
                      setError(undefined);
                    }}
                  />
                  <span>
                    <strong>改日期</strong>
                    <small>提前或延期</small>
                  </span>
                </label>
              </div>
              {dateChoice === "custom" ? (
                <div className="income-custom-date">
                  <label htmlFor="income-target-date">选择日期</label>
                  <div className="date-input">
                    <CalendarClock aria-hidden="true" />
                    <input
                      id="income-target-date"
                      type="date"
                      value={targetDateInput}
                      min={targetDateMinimum}
                      max={targetDateMaximum}
                      aria-invalid={Boolean(dateError)}
                      aria-describedby={dateError
                        ? "income-target-date-help income-target-date-error"
                        : "income-target-date-help"}
                      onChange={(event) => {
                        setTargetDateInput(event.target.value);
                        setError(undefined);
                      }}
                    />
                  </div>
                  <p id="income-target-date-help" className="field-help">只改这一次</p>
                  {dateError ? (
                    <p id="income-target-date-error" className="field-error" role="alert">{dateError}</p>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          ) : mode === "postpone" ? (
            <div className="income-postpone-fields">
              <div className="field-group">
                <label htmlFor="income-target-date">到账日</label>
                <div className="date-input">
                  <CalendarClock aria-hidden="true" />
                  <input
                    id="income-target-date"
                    type="date"
                    data-autofocus
                    value={targetDateInput}
                    min={targetDateMinimum}
                    max={targetDateMaximum}
                    aria-invalid={Boolean(dateError)}
                    aria-describedby={dateError
                      ? "income-target-date-help income-target-date-error"
                      : "income-target-date-help"}
                    onChange={(event) => {
                      setTargetDateInput(event.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
                <p id="income-target-date-help" className="field-help">不改常规日</p>
                {dateError ? (
                  <p id="income-target-date-error" className="field-error" role="alert">{dateError}</p>
                ) : null}
              </div>
              <dl className="income-postpone-summary">
                <div><dt>预计额</dt><dd>{formatCny(existing!.expectedIncomeMinor)}</dd></div>
              </dl>
            </div>
          ) : null}

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
                    aria-invalid={Boolean(expectedError)}
                    aria-describedby={expectedError
                      ? "income-dialog-help expected-income-error"
                      : "income-dialog-help"}
                    onChange={(event) => {
                      setExpectedInput(event.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
                <p id="income-dialog-help" className="field-help">不会自动记账</p>
                {expectedError ? (
                  <p id="expected-income-error" className="field-error" role="alert">{expectedError}</p>
                ) : null}
              </div>
            </div>
          ) : mode === "actual" ? (
            <div className="income-settlement-fields">
              <div className="field-group income-actual-date">
                <label htmlFor="income-target-date">到账日</label>
                <div className="date-input">
                  <CalendarClock aria-hidden="true" />
                  <input
                    id="income-target-date"
                    type="date"
                    value={targetDateInput}
                    min={existing?.targetPaydayDateKey}
                    max={todayDateKey}
                    aria-invalid={Boolean(dateError)}
                    aria-describedby={dateError ? "actual-date-error" : undefined}
                    onChange={(event) => {
                      setTargetDateInput(event.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
                {dateError ? (
                  <p id="actual-date-error" className="field-error" role="alert">{dateError}</p>
                ) : null}
              </div>
              <div className="field-group income-actual-field">
                <label htmlFor="actual-income">实际额</label>
                <div className="signed-input">
                  <span aria-hidden="true">¥</span>
                  <input
                    id="actual-income"
                    data-autofocus
                    inputMode="decimal"
                    value={actualInput}
                    aria-invalid={Boolean(actualError)}
                    aria-describedby={actualError
                      ? "actual-income-help actual-income-error"
                      : "actual-income-help"}
                    onChange={(event) => {
                      setActualInput(event.target.value);
                      setError(undefined);
                    }}
                  />
                </div>
                <p id="actual-income-help" className="field-help">填 0 不生成账目</p>
                {actualError ? (
                  <p id="actual-income-error" className="field-error" role="alert">{actualError}</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {error?.field === "form" ? (
            <p className="field-error" role="alert">{error.message}</p>
          ) : null}

          <div className="modal-actions">
            <button type="button" className="text-button" onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : mode === "actual" ? (
                <WalletCards aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              {saving
                ? "保存中"
                : mode === "actual"
                  ? "确认收入"
                  : mode === "postpone"
                    ? "保存日期"
                    : replaceDueForecast
                      ? "设为下次"
                      : "保存预计"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
