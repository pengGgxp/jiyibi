import { CircleAlert, LoaderCircle, Minus, PiggyBank, Plus, ReceiptText } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createSavingsFundedExpense, releaseSavings, reserveSavings } from "../data";
import {
  amountMinorToInput,
  currentLocalDateTimeInput,
  formatCny,
  parseSignedAmountToMinor,
  type EntryTreatment,
  type LedgerEntry,
} from "../domain";
import { Modal } from "./Modal";

export type SavingsDialogMode = "reserve" | "release";

interface SavingsDialogProps {
  open: boolean;
  mode: SavingsDialogMode;
  retainedMinor: bigint;
  availableMinor: bigint;
  linkedExpense?: LedgerEntry;
  suggestedAmountMinor?: number;
  onClose(): void;
  onSaved(message: string): void;
}

type ExpenseTreatment = Extract<
  EntryTreatment,
  "ordinary_expense" | "one_time_expense" | "reimbursable_expense"
>;

type SavingsField = "amount" | "expense" | "note" | "form";

function parsePositiveAmount(input: string, label: string): number {
  const value = parseSignedAmountToMinor(input);
  if (value <= 0) throw new Error(`${label}必须大于 0`);
  return value;
}

export function SavingsDialog({
  open,
  mode,
  retainedMinor,
  availableMinor,
  linkedExpense,
  suggestedAmountMinor,
  onClose,
  onSaved,
}: SavingsDialogProps) {
  const [amountInput, setAmountInput] = useState("");
  const [note, setNote] = useState("");
  const [releaseDestination, setReleaseDestination] = useState<"available" | "expense">("available");
  const [expenseInput, setExpenseInput] = useState("");
  const [treatment, setTreatment] = useState<ExpenseTreatment>("one_time_expense");
  const [error, setError] = useState<{ field: SavingsField; message: string }>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmountInput(
      linkedExpense && suggestedAmountMinor !== undefined
        ? amountMinorToInput(suggestedAmountMinor)
        : "",
    );
    setNote(linkedExpense?.note ?? "");
    setReleaseDestination("available");
    setExpenseInput("");
    setTreatment("one_time_expense");
    setError(undefined);
    setSaving(false);
  }, [linkedExpense, mode, open, suggestedAmountMinor]);

  const linkedExpenseAmount = linkedExpense ? BigInt(Math.abs(linkedExpense.amountMinor)) : undefined;
  const linkedExpenseLimit = linkedExpenseAmount !== undefined && retainedMinor > linkedExpenseAmount
    ? linkedExpenseAmount
    : retainedMinor;
  const limit = mode === "reserve" ? availableMinor : linkedExpenseLimit;
  const isDirectExpense = mode === "release" && !linkedExpense && releaseDestination === "expense";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      let amountMinor: number;
      try {
        amountMinor = parsePositiveAmount(amountInput, mode === "reserve" ? "存入金额" : "取用金额");
      } catch (reason) {
        setError({
          field: "amount",
          message: reason instanceof Error ? reason.message : "金额无效",
        });
        return;
      }
      if (BigInt(amountMinor) > limit) {
        setError({
          field: "amount",
          message: mode === "reserve" ? "金额超过可花余额" : "金额超过已有存款",
        });
        return;
      }

      if (mode === "reserve") {
        await reserveSavings({ amountMinor, note });
        onSaved("已存一笔");
      } else if (linkedExpense) {
        await releaseSavings({
          amountMinor,
          note: note || linkedExpense.note || "支出动用存款",
          linkedExpenseEntryId: linkedExpense.id,
        });
        onSaved("已确认取用");
      } else if (releaseDestination === "available") {
        await releaseSavings({ amountMinor, note });
        onSaved("已转为可花");
      } else {
        let expenseMinor: number;
        try {
          expenseMinor = parsePositiveAmount(expenseInput, "支出总额");
        } catch (reason) {
          setError({
            field: "expense",
            message: reason instanceof Error ? reason.message : "金额无效",
          });
          return;
        }
        if (amountMinor > expenseMinor) {
          setError({ field: "amount", message: "取用不能超过支出" });
          return;
        }
        if (!note.trim()) {
          setError({ field: "note", message: "请填写支出说明" });
          return;
        }
        await createSavingsFundedExpense({
          kind: "expense",
          amount: expenseInput,
          note,
          occurredAtLocal: currentLocalDateTimeInput(),
        }, amountMinor, undefined, new Date(), treatment);
        onSaved("支出已记录");
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

  return (
    <Modal
      open={open}
      title={mode === "reserve" ? "存一笔" : linkedExpense ? "确认取用" : "取用存款"}
      description={mode === "reserve"
        ? "存入后会减少可花余额，总余额不变。"
        : linkedExpense
          ? "确认这笔支出实际用了多少存款。"
          : "取用不会被记作收入。"}
      onClose={onClose}
    >
      <form className="savings-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="savings-balance-note">
          <PiggyBank aria-hidden="true" />
          <span>{mode === "reserve" ? "当前可花" : "当前已存"}</span>
          <strong>{formatCny(limit > 0n ? limit : 0n)}</strong>
        </div>

        {mode === "release" && !linkedExpense ? (
          <fieldset className="segmented-field savings-destination">
            <legend>取用方式</legend>
            <div className="segmented-control">
              <button
                type="button"
                className={releaseDestination === "available" ? "is-active" : ""}
                aria-pressed={releaseDestination === "available"}
                onClick={() => setReleaseDestination("available")}
              >
                <Minus aria-hidden="true" /> 转为可花
              </button>
              <button
                type="button"
                className={releaseDestination === "expense" ? "is-active" : ""}
                aria-pressed={releaseDestination === "expense"}
                onClick={() => setReleaseDestination("expense")}
              >
                <ReceiptText aria-hidden="true" /> 直接支出
              </button>
            </div>
          </fieldset>
        ) : null}

        {isDirectExpense ? (
          <div className="field-group">
            <label htmlFor="savings-expense-total">支出总额</label>
            <div className="signed-input"><span aria-hidden="true">¥</span><input
              id="savings-expense-total"
              inputMode="decimal"
              value={expenseInput}
              aria-invalid={error?.field === "expense"}
              aria-describedby={error?.field === "expense" ? "savings-dialog-error" : undefined}
              onChange={(event) => { setExpenseInput(event.target.value); setError(undefined); }}
            /></div>
          </div>
        ) : null}

        <div className="field-group">
          <label htmlFor="savings-amount">
            {isDirectExpense || linkedExpense ? "使用存款" : "金额"}
          </label>
          <div className="signed-input"><span aria-hidden="true">¥</span><input
            id="savings-amount"
            data-autofocus
            inputMode="decimal"
            value={amountInput}
            aria-invalid={error?.field === "amount"}
            aria-describedby={error?.field === "amount" ? "savings-dialog-error savings-dialog-help" : "savings-dialog-help"}
            onChange={(event) => { setAmountInput(event.target.value); setError(undefined); }}
          /></div>
        </div>

        <div className="field-group">
          <label htmlFor="savings-note">{isDirectExpense ? "支出说明" : "备注（可选）"}</label>
          <input
            id="savings-note"
            maxLength={200}
            value={note}
            aria-invalid={error?.field === "note"}
            aria-describedby={error?.field === "note" ? "savings-dialog-error" : undefined}
            onChange={(event) => { setNote(event.target.value); setError(undefined); }}
          />
        </div>

        {isDirectExpense ? (
          <div className="field-group">
            <label htmlFor="savings-expense-treatment">统计方式</label>
            <select
              id="savings-expense-treatment"
              value={treatment}
              onChange={(event) => setTreatment(event.target.value as ExpenseTreatment)}
            >
              <option value="one_time_expense">仅这一次</option>
              <option value="ordinary_expense">日常支出</option>
              <option value="reimbursable_expense">待报销</option>
            </select>
          </div>
        ) : null}

        <p id="savings-dialog-help" className="field-help">
          {isDirectExpense || linkedExpense ? "支出与取用会保持关联。" : "总余额不会因此改变。"}
        </p>
        {limit <= 0n ? (
          <p className="field-warning"><CircleAlert aria-hidden="true" /> 当前无可用金额</p>
        ) : null}
        {error ? <p id="savings-dialog-error" className="field-error" role="alert">{error.message}</p> : null}

        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || limit <= 0n}>
            {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : mode === "reserve" ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}
            {saving ? "保存中" : isDirectExpense ? "记录支出" : mode === "reserve" ? "确认存入" : "确认取用"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
