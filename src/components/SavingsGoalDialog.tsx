import { CalendarDays, CircleAlert, LoaderCircle, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clearSavingsGoal, setSavingsGoal } from "../data";
import {
  amountMinorToInput,
  currentLocalDateKey,
  localDateFromKey,
  parseSignedAmountToMinor,
  type AppSettings,
} from "../domain";
import { Modal } from "./Modal";

interface SavingsGoalDialogProps {
  open: boolean;
  settings?: AppSettings;
  onClose(): void;
  onSaved(message: string): void;
}

type GoalField = "amount" | "date" | "form";

export function SavingsGoalDialog({
  open,
  settings,
  onClose,
  onSaved,
}: SavingsGoalDialogProps) {
  const [amountInput, setAmountInput] = useState("0.00");
  const [dateInput, setDateInput] = useState("");
  const [error, setError] = useState<{ field: GoalField; message: string }>();
  const [saving, setSaving] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const initialized = useRef(false);
  const existing = settings?.savingsGoal;
  const today = currentLocalDateKey();

  useEffect(() => {
    if (!open) {
      initialized.current = false;
      setError(undefined);
      setSaving(false);
      setConfirmingClear(false);
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    setAmountInput(amountMinorToInput(existing?.targetMinor ?? 0));
    setDateInput(existing?.targetDateKey ?? "");
  }, [existing, open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let targetMinor: number;
    try {
      targetMinor = parseSignedAmountToMinor(amountInput);
      if (targetMinor <= 0) {
        setError({ field: "amount", message: "目标额需大于 0" });
        return;
      }
    } catch {
      setError({ field: "amount", message: "金额无效" });
      return;
    }
    try {
      localDateFromKey(dateInput);
      if (dateInput < today) {
        setError({ field: "date", message: "截止日不能早于今天" });
        return;
      }
    } catch {
      setError({ field: "date", message: "日期无效" });
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      await setSavingsGoal({ targetDateKey: dateInput, targetMinor });
      onSaved(existing ? "目标已更新" : "目标已设置");
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

  const clear = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await clearSavingsGoal();
      onSaved("目标已清除");
      onClose();
    } catch (reason) {
      setError({
        field: "form",
        message: reason instanceof Error ? reason.message : "清除失败，请重试",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={existing ? "修改目标" : "存钱目标"}
      description="设定总额和截止日，不随发薪周期重置。"
      onClose={onClose}
    >
      <form className="income-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="income-dialog-fields">
          <div className="field-group">
            <label htmlFor="savings-goal-amount">目标额</label>
            <div className="signed-input">
              <span aria-hidden="true">¥</span>
              <input
                id="savings-goal-amount"
                data-autofocus
                inputMode="decimal"
                value={amountInput}
                aria-invalid={error?.field === "amount"}
                aria-describedby={error?.field === "amount" ? "savings-goal-error" : undefined}
                onChange={(event) => {
                  setAmountInput(event.target.value);
                  setError(undefined);
                  setConfirmingClear(false);
                }}
              />
            </div>
          </div>
          <div className="field-group">
            <label htmlFor="savings-goal-date">截止日</label>
            <div className="date-input">
              <CalendarDays aria-hidden="true" />
              <input
                id="savings-goal-date"
                type="date"
                min={today}
                value={dateInput}
                aria-invalid={error?.field === "date"}
                aria-describedby={error?.field === "date" ? "savings-goal-error" : undefined}
                onChange={(event) => {
                  setDateInput(event.target.value);
                  setError(undefined);
                  setConfirmingClear(false);
                }}
              />
            </div>
          </div>
        </div>

        {error ? (
          <p id="savings-goal-error" className="field-error" role="alert">
            <CircleAlert aria-hidden="true" /> {error.message}
          </p>
        ) : null}

        {confirmingClear ? (
          <div className="goal-clear-confirm" role="group" aria-label="确认清除存钱目标">
            <p>存钱记录会保留。</p>
            <button type="button" className="text-button" onClick={() => setConfirmingClear(false)}>
              取消
            </button>
            <button type="button" className="destructive-button" disabled={saving} onClick={() => void clear()}>
              <Trash2 aria-hidden="true" /> 确认清除
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            {existing ? (
              <button type="button" className="text-button" onClick={() => setConfirmingClear(true)}>
                <Trash2 aria-hidden="true" /> 清除目标
              </button>
            ) : (
              <button type="button" className="text-button" onClick={onClose}>取消</button>
            )}
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}
              {saving ? "保存中" : "保存目标"}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
