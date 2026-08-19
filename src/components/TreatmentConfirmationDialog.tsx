import { ArrowLeft, Link2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  activeRecoveryAmount,
  amountMinorToInput,
  formatCny,
  isRecoverableExpenseTreatment,
  parseUnsignedAmountToMinor,
  type EntryTreatment,
  type LedgerEntry,
  type RecoveryAllocation,
} from "../domain";
import {
  expenseTreatmentOptions,
  incomeTreatmentOptions,
  type ExceptionPromptKind,
} from "../domain/exception-prompt";
import { Modal } from "./Modal";

const EMPTY_ENTRIES: readonly LedgerEntry[] = [];
const EMPTY_ALLOCATIONS: readonly RecoveryAllocation[] = [];

export interface TreatmentConfirmationDialogProps {
  entry?: LedgerEntry;
  kind: ExceptionPromptKind;
  entries?: readonly LedgerEntry[];
  allocations?: readonly RecoveryAllocation[];
  busy?: boolean;
  error?: string;
  onConfirm(
    treatment: EntryTreatment,
    allocations?: readonly RecoveryAllocationSelection[],
  ): void | Promise<void>;
  onDefer(): void | Promise<void>;
  onClose(): void;
}

export interface RecoveryAllocationSelection {
  expenseEntryId: string;
  amountMinor: number;
}

interface RecoveryCandidate {
  entry: LedgerEntry;
  availableMinor: number;
  existingMinor: number;
}

function recoveryCandidates(
  refund: LedgerEntry,
  entries: readonly LedgerEntry[],
  allocations: readonly RecoveryAllocation[],
): RecoveryCandidate[] {
  return entries
    .filter((entry) =>
      entry.id !== refund.id && !entry.deletedAt && entry.amountMinor < 0 &&
      entry.occurredAt <= refund.occurredAt && isRecoverableExpenseTreatment(entry.treatment))
    .map((entry) => {
      const existingMinor = activeRecoveryAmount(
        allocations,
        (allocation) => allocation.refundEntryId === refund.id && allocation.expenseEntryId === entry.id,
      );
      const claimedByOthers = activeRecoveryAmount(
        allocations,
        (allocation) => allocation.refundEntryId !== refund.id && allocation.expenseEntryId === entry.id,
      );
      return {
        entry,
        existingMinor,
        availableMinor: Math.max(Math.abs(entry.amountMinor) - claimedByOthers, 0),
      };
    })
    .filter((candidate) => candidate.availableMinor > 0)
    .sort((left, right) => right.entry.occurredAt.localeCompare(left.entry.occurredAt));
}

export function TreatmentConfirmationDialog({
  entry,
  kind,
  entries = EMPTY_ENTRIES,
  allocations = EMPTY_ALLOCATIONS,
  busy = false,
  error,
  onConfirm,
  onDefer,
}: TreatmentConfirmationDialogProps) {
  const options = useMemo(
    () => kind === "expense" ? expenseTreatmentOptions() : incomeTreatmentOptions(),
    [kind],
  );
  const defaultTreatment = kind === "expense" ? "ordinary_expense" : "ordinary_income";
  const [selected, setSelected] = useState<EntryTreatment>(defaultTreatment);
  const [step, setStep] = useState<"treatment" | "allocation">("treatment");
  const [allocationInputs, setAllocationInputs] = useState<Record<string, string>>({});
  const [allocationError, setAllocationError] = useState<string>();
  const candidates = useMemo(
    () => entry ? recoveryCandidates(entry, entries, allocations) : [],
    [allocations, entries, entry],
  );

  useEffect(() => {
    setSelected(entry?.treatment && options.some((option) => option.value === entry.treatment)
      ? entry.treatment
      : defaultTreatment);
    setStep("treatment");
    setAllocationError(undefined);
  }, [entry?.id, entry?.treatment, defaultTreatment, options]);

  useEffect(() => {
    if (!entry) return;
    const next = Object.fromEntries(candidates
      .filter((candidate) => candidate.existingMinor > 0)
      .map((candidate) => [candidate.entry.id, amountMinorToInput(candidate.existingMinor)]));
    if (Object.keys(next).length === 0) {
      const exact = candidates.find(
        (candidate) => Math.abs(candidate.availableMinor - entry.amountMinor) <= 100,
      );
      if (exact) next[exact.entry.id] = amountMinorToInput(Math.min(entry.amountMinor, exact.availableMinor));
    }
    setAllocationInputs(next);
  }, [candidates, entry]);

  if (!entry) return null;

  const title = step === "allocation"
    ? "关联支出"
    : kind === "expense" ? "这笔支出会明显影响估算" : "确认这笔资金的来源";
  const description = kind === "expense"
    ? "账目已经保存。请选择它是否代表平时的花法。"
    : step === "allocation"
      ? "把退款分摊到原支出，日常花法会按实际承担金额重算。"
      : "账目已经保存。这个选择只影响余额解释和统计口径。";

  const confirmSelection = () => {
    if (selected === "refund_reimbursement" && candidates.length > 0 && step === "treatment") {
      setStep("allocation");
      return;
    }
    void onConfirm(selected);
  };

  const saveAllocations = () => {
    try {
      const selections = Object.entries(allocationInputs)
        .filter(([, value]) => value.trim() !== "")
        .map(([expenseEntryId, value]) => ({
          expenseEntryId,
          amountMinor: parseUnsignedAmountToMinor(value),
        }));
      const total = selections.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
      if (total > BigInt(entry.amountMinor)) throw new Error("分摊不能超过退款金额");
      for (const selection of selections) {
        const candidate = candidates.find((item) => item.entry.id === selection.expenseEntryId);
        if (!candidate || selection.amountMinor > candidate.availableMinor) {
          throw new Error("分摊不能超过原支出");
        }
      }
      setAllocationError(undefined);
      void onConfirm("refund_reimbursement", selections);
    } catch (reason) {
      setAllocationError(reason instanceof Error ? reason.message : "金额无效");
    }
  };

  const deferAllocation = () => {
    const existingSelections = candidates
      .filter((candidate) => candidate.existingMinor > 0)
      .map((candidate) => ({
        expenseEntryId: candidate.entry.id,
        amountMinor: candidate.existingMinor,
      }));
    void onConfirm("refund_reimbursement", existingSelections);
  };

  return (
    <Modal open title={title} description={description} onClose={() => void onDefer()}>
      <div className="treatment-confirm">
        <p className="treatment-confirm-amount">
          {entry.amountMinor < 0 ? "支出" : "收入"} {formatCny(Math.abs(entry.amountMinor))}
          {entry.note ? <span> · {entry.note}</span> : null}
        </p>
        {step === "treatment" ? <div className="treatment-confirm-options" role="radiogroup" aria-label="处理方式">
          {options.map((option, index) => (
            <label
              key={option.value}
              className={`treatment-confirm-option${selected === option.value ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="treatment"
                value={option.value}
                checked={selected === option.value}
                data-autofocus={index === 0 ? true : undefined}
                disabled={busy}
                onChange={() => setSelected(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </div> : (
          <fieldset className="recovery-allocation-list">
            <legend>选择原支出</legend>
            {candidates.map((candidate) => {
              const selectedCandidate = allocationInputs[candidate.entry.id] !== undefined;
              return (
                <div className={`recovery-allocation-row${selectedCandidate ? " is-selected" : ""}`} key={candidate.entry.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedCandidate}
                      disabled={busy}
                      onChange={(event) => setAllocationInputs((current) => {
                        const next = { ...current };
                        if (event.target.checked) {
                          const used = Object.values(current).reduce((sum, value) => {
                            try { return sum + parseUnsignedAmountToMinor(value); } catch { return sum; }
                          }, 0);
                          next[candidate.entry.id] = amountMinorToInput(
                            Math.min(candidate.availableMinor, Math.max(entry.amountMinor - used, 1)),
                          );
                        } else {
                          delete next[candidate.entry.id];
                        }
                        return next;
                      })}
                    />
                    <span><strong>{candidate.entry.note || "支出记录"}</strong><small>{candidate.entry.localDateKey} · 可关联 {formatCny(candidate.availableMinor)}</small></span>
                  </label>
                  {selectedCandidate ? (
                    <div className="recovery-allocation-amount">
                      <span aria-hidden="true">¥</span>
                      <input
                        aria-label={`${candidate.entry.note || "支出记录"}的分摊金额`}
                        inputMode="decimal"
                        value={allocationInputs[candidate.entry.id]}
                        disabled={busy}
                        onChange={(event) => setAllocationInputs((current) => ({
                          ...current,
                          [candidate.entry.id]: event.target.value,
                        }))}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </fieldset>
        )}
        {allocationError ? <p className="form-error" role="alert">{allocationError}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="dialog-actions">
          {step === "allocation" ? <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setStep("treatment")}
          >
            <ArrowLeft aria-hidden="true" /> 返回
          </button> : <button type="button" className="text-button" disabled={busy} onClick={() => void onDefer()}>稍后处理</button>}
          {step === "allocation" ? (
            <button type="button" className="text-button" disabled={busy} onClick={deferAllocation}>
              稍后关联
            </button>
          ) : null}
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={step === "allocation" ? saveAllocations : confirmSelection}
          >
            {busy ? "保存中…" : step === "allocation" ? <><Link2 aria-hidden="true" /> 关联</> : "确认"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
