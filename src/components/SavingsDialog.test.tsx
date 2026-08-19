import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../domain";
import { SavingsDialog, type SavingsDialogMode } from "./SavingsDialog";

const dataMocks = vi.hoisted(() => ({
  createSavingsFundedExpense: vi.fn(),
  releaseSavings: vi.fn(),
  reserveSavings: vi.fn(),
}));
vi.mock("../data", () => dataMocks);
vi.mock("./Modal", () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open
    ? <section aria-label={title}>{children}</section>
    : null,
}));

const linkedExpense: LedgerEntry = {
  id: "expense-1",
  amountMinor: -8_000,
  note: "临时支出",
  occurredAt: "2026-08-18T04:00:00.000Z",
  localDateKey: "2026-08-18",
  localMonthKey: "2026-08",
  timezoneOffsetMinutes: -480,
  treatment: "ordinary_expense",
  confirmationStatus: "not_needed",
  createdAt: "2026-08-18T04:00:00.000Z",
  updatedAt: "2026-08-18T04:00:00.000Z",
};

const roots: Root[] = [];
const reactEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousAct = reactEnv.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { reactEnv.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => {
  if (previousAct === undefined) Reflect.deleteProperty(reactEnv, "IS_REACT_ACT_ENVIRONMENT");
  else reactEnv.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
beforeEach(() => { for (const mock of Object.values(dataMocks)) mock.mockReset().mockResolvedValue(undefined); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

async function renderDialog({
  mode,
  expense,
  suggestedAmountMinor,
  retainedMinor = 20_000n,
  availableMinor = 15_000n,
}: {
  mode: SavingsDialogMode;
  expense?: LedgerEntry;
  suggestedAmountMinor?: number;
  retainedMinor?: bigint;
  availableMinor?: bigint;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  await act(async () => root.render(
    <SavingsDialog
      open
      mode={mode}
      retainedMinor={retainedMinor}
      availableMinor={availableMinor}
      linkedExpense={expense}
      suggestedAmountMinor={suggestedAmountMinor}
      onClose={onClose}
      onSaved={onSaved}
    />,
  ));
  return { host, onClose, onSaved };
}

function field(host: HTMLElement, label: string): HTMLInputElement {
  const target = Array.from(host.querySelectorAll("label")).find((item) => item.textContent?.includes(label));
  const input = target?.htmlFor ? host.querySelector<HTMLInputElement>(`#${target.htmlFor}`) : null;
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}

async function fill(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => { setter?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function click(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

describe("SavingsDialog", () => {
  it("stores an amount without creating a cycle settlement", async () => {
    const { host, onSaved } = await renderDialog({ mode: "reserve" });
    await fill(field(host, "金额"), "25.00");
    await fill(field(host, "备注"), "目标存款");
    await click(host, "确认存入");
    expect(dataMocks.reserveSavings).toHaveBeenCalledWith({ amountMinor: 2_500, note: "目标存款" });
    expect(onSaved).toHaveBeenCalledWith("已存一笔");
    expect(host.textContent).not.toContain("周期结算");
  });

  it("releases savings as spendable money", async () => {
    const { host, onSaved } = await renderDialog({ mode: "release" });
    await fill(field(host, "金额"), "50.00");
    await click(host, "确认取用");
    expect(dataMocks.releaseSavings).toHaveBeenCalledWith({ amountMinor: 5_000, note: "" });
    expect(onSaved).toHaveBeenCalledWith("已转为可花");
  });

  it("links the used savings to an existing expense", async () => {
    const { host } = await renderDialog({ mode: "release", expense: linkedExpense, suggestedAmountMinor: 3_500 });
    expect(field(host, "使用存款").value).toBe("35.00");
    await click(host, "确认取用");
    expect(dataMocks.releaseSavings).toHaveBeenCalledWith({
      amountMinor: 3_500,
      note: "临时支出",
      linkedExpenseEntryId: "expense-1",
    });
  });

  it("creates a direct one-time expense with a linked savings release", async () => {
    const { host } = await renderDialog({ mode: "release" });
    await click(host, "直接支出");
    await fill(field(host, "支出总额"), "120.00");
    await fill(field(host, "使用存款"), "50.00");
    await fill(field(host, "支出说明"), "更换手机");
    await click(host, "记录支出");
    expect(dataMocks.createSavingsFundedExpense).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "expense", amount: "120.00", note: "更换手机" }),
      5_000,
      undefined,
      expect.any(Date),
      "one_time_expense",
    );
  });

  it("keeps input when the amount exceeds available money", async () => {
    const { host, onClose } = await renderDialog({ mode: "reserve", availableMinor: 1_000n });
    const amount = field(host, "金额");
    await fill(amount, "20.00");
    await click(host, "确认存入");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("金额超过可花余额");
    expect(amount.value).toBe("20.00");
    expect(onClose).not.toHaveBeenCalled();
  });
});
