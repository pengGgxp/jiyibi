import { CheckCircle2, CircleAlert, LoaderCircle, Minus, PiggyBank, Plus, ReceiptText } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  createSavingsFundedExpense,
  releaseSavings,
  reserveSavings,
  settleSavingsCycle,
} from "../data";
import {
  amountMinorToInput,
  currentLocalDateTimeInput,
  formatCny,
  parseSignedAmountToMinor,
  type EntryTreatment,
  type LedgerEntry,
} from "../domain";
import { Modal } from "./Modal";

export type SavingsDialogMode = "reserve" | "release" | "settle";

export interface SavingsSettlementContext {
  cycleStartDateKey: string;
  cycleEndDateKey: string;
  goalMinorSnapshot: number;
  suggestedAmountMinor: number;
  correction?: {
    currentAmountMinor: number;
    openingRetainedMinor: number;
    closingRetainedMinor: number;
    netGrowthMinor: number;
    note: string;
    occurredAtLocal: string;
  };
}

interface SavingsDialogProps {
  open: boolean;
  mode: SavingsDialogMode;
  retainedMinor: bigint;
  availableMinor: bigint;
  linkedExpense?: LedgerEntry;
  suggestedAmountMinor?: number;
  settlement?: SavingsSettlementContext;
  onClose(): void;
  onSaved(message: string): void;
}

type ExpenseTreatment = Extract<
  EntryTreatment,
  "ordinary_expense" | "one_time_expense" | "reimbursable_expense"
>;

function parsePositiveAmount(input: string, label: string): number {
  const value = parseSignedAmountToMinor(input);
  if (value <= 0) throw new Error(`${label}必须大于 0`);
  return value;
}

function parseNonNegativeAmount(input: string, label: string): number {
  const value = parseSignedAmountToMinor(input);
  if (value < 0) throw new Error(`${label}不能小于 0`);
  return value;
}

type SavingsField = "amount" | "expense" | "goal" | "note" | "form";

interface SavingsFormError {
  field: SavingsField;
  message: string;
}

export function SavingsDialog({
  open,
  mode,
  retainedMinor,
  availableMinor,
  linkedExpense,
  suggestedAmountMinor,
  settlement,
  onClose,
  onSaved,
}: SavingsDialogProps) {
  const [amountInput, setAmountInput] = useState("");
  const [goalInput, setGoalInput] = useState("");
  const [note, setNote] = useState("");
  const [releaseDestination, setReleaseDestination] = useState<"available" | "expense">("available");
  const [expenseInput, setExpenseInput] = useState("");
  const [treatment, setTreatment] = useState<ExpenseTreatment>("one_time_expense");
  const [error, setError] = useState<SavingsFormError>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmountInput(
      mode === "settle"
        ? amountMinorToInput(settlement?.suggestedAmountMinor ?? 0)
        : linkedExpense && suggestedAmountMinor !== undefined
          ? amountMinorToInput(suggestedAmountMinor)
          : "",
    );
    setGoalInput(amountMinorToInput(settlement?.goalMinorSnapshot ?? 0));
    setNote(settlement?.correction?.note ?? linkedExpense?.note ?? "");
    setReleaseDestination("available");
    setExpenseInput("");
    setTreatment("one_time_expense");
    setError(undefined);
    setSaving(false);
  }, [
    linkedExpense,
    mode,
    open,
    settlement?.correction?.note,
    settlement?.goalMinorSnapshot,
    settlement?.suggestedAmountMinor,
    suggestedAmountMinor,
  ]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      let amountMinor: number;
      try {
        amountMinor = mode === "settle"
          ? parseNonNegativeAmount(amountInput, "结算留存")
          : parsePositiveAmount(amountInput, mode === "reserve" ? "留存金额" : "取用金额");
      } catch (reason) {
        setError({
          field: "amount",
          message: reason instanceof Error ? reason.message : "金额格式无效",
        });
        return;
      }
      if (BigInt(amountMinor) > limit) {
        setError({
          field: "amount",
          message: mode === "reserve"
            ? "留存金额不能超过当前可花资金"
            : mode === "settle"
              ? "本次留存不能超过当前可用资金"
              : "取用金额不能超过当前已留存",
        });
        return;
      }
      if (mode === "reserve") {
        await reserveSavings({ amountMinor, note });
        onSaved("已留存一笔");
      } else if (mode === "settle") {
        if (!settlement) {
          setError({ field: "form", message: "没有可结算的工资周期" });
          return;
        }
        let goalMinorSnapshot = settlement.goalMinorSnapshot;
        if (settlement.correction) {
          try {
            goalMinorSnapshot = parseNonNegativeAmount(goalInput, "本周期目标");
          } catch (reason) {
            setError({
              field: "goal",
              message: reason instanceof Error ? reason.message : "本周期目标格式无效",
            });
            return;
          }
        }
        await settleSavingsCycle({
          cycleStartDateKey: settlement.cycleStartDateKey,
          cycleEndDateKey: settlement.cycleEndDateKey,
          goalMinorSnapshot,
          amountMinor,
          note: note || "周期留存结算",
          ...(settlement.correction
            ? { occurredAtLocal: settlement.correction.occurredAtLocal }
            : {}),
        });
        onSaved(settlement.correction ? "结算已更正" : "上个周期已结算");
      } else if (linkedExpense) {
        await releaseSavings({
          amountMinor,
          note: note || linkedExpense.note || "支出动用留存",
          linkedExpenseEntryId: linkedExpense.id,
        });
        onSaved("已确认这笔支出动用留存");
      } else if (releaseDestination === "available") {
        await releaseSavings({ amountMinor, note });
        onSaved("留存已释放为可花资金");
      } else {
        let expenseMinor: number;
        try {
          expenseMinor = parsePositiveAmount(expenseInput, "支出总额");
        } catch (reason) {
          setError({
            field: "expense",
            message: reason instanceof Error ? reason.message : "支出总额格式无效",
          });
          return;
        }
        if (amountMinor > expenseMinor) {
          setError({ field: "amount", message: "使用的留存不能超过支出总额" });
          return;
        }
        if (!note.trim()) {
          setError({ field: "note", message: "直接支出需要填写说明" });
          return;
        }
        await createSavingsFundedExpense({
          kind: "expense",
          amount: expenseInput,
          note,
          occurredAtLocal: currentLocalDateTimeInput(),
        }, amountMinor, undefined, new Date(), treatment);
        onSaved("支出和留存取用已记录");
      }
      onClose();
    } catch (reason) {
      setError({
        field: "form",
        message: reason instanceof Error ? reason.message : "留存操作没有保存，请重试",
      });
    } finally {
      setSaving(false);
    }
  };

  const isSettlement = mode === "settle";
  const settlementCorrection = settlement?.correction;
  const isSettlementCorrection = isSettlement && settlementCorrection !== undefined;
  const isDirectExpense = mode === "release" && !linkedExpense && releaseDestination === "expense";
  const linkedExpenseAmount = linkedExpense ? BigInt(Math.abs(linkedExpense.amountMinor)) : undefined;
  const linkedExpenseLimit = linkedExpenseAmount !== undefined && retainedMinor > linkedExpenseAmount
    ? linkedExpenseAmount
    : retainedMinor;
  const settlementLimit = availableMinor
    + BigInt(settlementCorrection?.currentAmountMinor ?? 0);
  const limit = mode === "reserve"
    ? availableMinor
    : isSettlement
      ? settlementLimit
      : linkedExpenseLimit;

  return (
    <Modal
      open={open}
      title={mode === "reserve"
        ? "留存一笔"
        : isSettlementCorrection
          ? "更正周期结算"
          : isSettlement
            ? "结算上个周期"
            : linkedExpense
              ? "确认动用留存"
              : "取用留存"}
      description={mode === "reserve"
        ? "留存仍在总余额中，但不再计入可花余额。"
        : isSettlementCorrection
          ? "更正本次再留存和当期目标，其他结算数据会重新计算。"
        : isSettlement
          ? "确认这个周期实际新增了多少留存；可以填 0。"
        : linkedExpense
          ? "账目已经保存，请确认这笔支出实际用了多少留存。"
          : "取用会减少已留存，不会被当作收入。"}
      onClose={onClose}
    >
      <form className="savings-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="savings-balance-note">
          <PiggyBank aria-hidden="true" />
          <span>{isSettlementCorrection
            ? "更正后最多可留存"
            : mode === "reserve" || isSettlement
              ? "当前可用于留存"
              : "当前已留存"}</span>
          <strong>{formatCny(limit > 0n ? limit : 0n)}</strong>
        </div>

        {isSettlement && settlement ? (
          <dl className="savings-settlement-summary">
            <div><dt>周期</dt><dd>{settlement.cycleStartDateKey} 至 {settlement.cycleEndDateKey}</dd></div>
            {!isSettlementCorrection ? (
              <div><dt>目标</dt><dd>{formatCny(settlement.goalMinorSnapshot)}</dd></div>
            ) : (
              <>
                <div><dt>原期初留存</dt><dd>{formatCny(settlementCorrection!.openingRetainedMinor)}</dd></div>
                <div><dt>原期末留存</dt><dd>{formatCny(settlementCorrection!.closingRetainedMinor)}</dd></div>
                <div><dt>原净增长</dt><dd>{formatCny(settlementCorrection!.netGrowthMinor)}</dd></div>
              </>
            )}
          </dl>
        ) : null}

        {isSettlementCorrection ? (
          <div className="field-group">
            <label htmlFor="savings-goal">本周期目标</label>
            <div className="signed-input"><span aria-hidden="true">¥</span><input
              id="savings-goal"
              inputMode="decimal"
              value={goalInput}
              aria-invalid={error?.field === "goal"}
              aria-describedby={error?.field === "goal" ? "savings-dialog-error savings-dialog-help" : "savings-dialog-help"}
              onChange={(event) => { setGoalInput(event.target.value); setError(undefined); }}
            /></div>
          </div>
        ) : null}

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
                <Minus aria-hidden="true" /> 释放为可花
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
            {isSettlement ? "本次再留存" : isDirectExpense || linkedExpense ? "其中使用留存" : "金额"}
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
            <label htmlFor="savings-expense-treatment">这笔支出如何统计</label>
            <select
              id="savings-expense-treatment"
              value={treatment}
              onChange={(event) => setTreatment(event.target.value as ExpenseTreatment)}
            >
              <option value="one_time_expense">仅这一次，不外推</option>
              <option value="ordinary_expense">日常支出</option>
              <option value="reimbursable_expense">待报销</option>
            </select>
          </div>
        ) : null}

        <p id="savings-dialog-help" className="field-help">
          {isDirectExpense || linkedExpense
            ? "支出和留存取用会保持关联；编辑、删除和撤销会联动处理。"
            : isSettlement
              ? isSettlementCorrection
                ? "保存后会更新原结算，不会新增重复记录；期末留存和净增长会重新计算。"
                : "结算只记录留存变化，不会生成收入或支出账目。"
            : "总余额不会因留存或释放本身改变。"}
        </p>
        {limit <= 0n && !isSettlement ? (
          <p className="field-warning"><CircleAlert aria-hidden="true" /> 当前没有可操作的金额。</p>
        ) : null}
        {error ? <p id="savings-dialog-error" className="field-error" role="alert">{error.message}</p> : null}

        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving || (!isSettlement && limit <= 0n)}>
            {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : mode === "reserve" ? <Plus aria-hidden="true" /> : isSettlement ? <CheckCircle2 aria-hidden="true" /> : <Minus aria-hidden="true" />}
            {saving
              ? "正在保存"
              : mode === "reserve"
                ? "确认留存"
                : isSettlementCorrection
                  ? "保存更正"
                  : isSettlement
                    ? "完成结算"
                    : isDirectExpense
                      ? "记录支出"
                      : "确认取用"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
