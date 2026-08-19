import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../domain";
import { SavingsDialog, type SavingsDialogMode, type SavingsSettlementContext } from "./SavingsDialog";

const dataMocks = vi.hoisted(() => ({
  createSavingsFundedExpense: vi.fn(),
  releaseSavings: vi.fn(),
  reserveSavings: vi.fn(),
  settleSavingsCycle: vi.fn(),
}));

vi.mock("../data", () => dataMocks);

vi.mock("./Modal", () => ({
  Modal: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: string;
    description?: string;
    children: ReactNode;
  }) => open ? (
    <section aria-label={title}>
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ) : null,
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

const settlement: SavingsSettlementContext = {
  cycleStartDateKey: "2026-07-10",
  cycleEndDateKey: "2026-08-09",
  goalMinorSnapshot: 10_000,
  suggestedAmountMinor: 3_000,
};

const mountedRoots: Root[] = [];
const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(reactTestEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

beforeEach(() => {
  for (const mock of Object.values(dataMocks)) mock.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

async function renderDialog({
  mode,
  expense,
  suggestedAmountMinor,
  settlementContext,
  retainedMinor = 20_000n,
  availableMinor = 15_000n,
}: {
  mode: SavingsDialogMode;
  expense?: LedgerEntry;
  suggestedAmountMinor?: number;
  settlementContext?: SavingsSettlementContext;
  retainedMinor?: bigint;
  availableMinor?: bigint;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  const onClose = vi.fn();
  const onSaved = vi.fn();
  await act(async () => {
    root.render(
      <SavingsDialog
        open
        mode={mode}
        retainedMinor={retainedMinor}
        availableMinor={availableMinor}
        linkedExpense={expense}
        suggestedAmountMinor={suggestedAmountMinor}
        settlement={settlementContext}
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
  });
  return { host, onClose, onSaved };
}

function field(host: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(host.querySelectorAll("label"));
  const target = labels.find((item) => item.textContent?.includes(label));
  const id = target?.htmlFor;
  const input = id ? host.querySelector<HTMLInputElement>(`#${id}`) : null;
  if (!input) throw new Error(`Missing field: ${label}`);
  return input;
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(host: HTMLElement, label: string) {
  const button = Array.from(host.querySelectorAll("button"))
    .find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

describe("SavingsDialog", () => {
  it("records an additional retained amount", async () => {
    const { host, onSaved, onClose } = await renderDialog({ mode: "reserve" });
    await fill(field(host, "金额"), "25.00");
    await fill(field(host, "备注"), "本周期追加");
    await click(host, "确认留存");

    expect(dataMocks.reserveSavings).toHaveBeenCalledWith({
      amountMinor: 2_500,
      note: "本周期追加",
    });
    expect(onSaved).toHaveBeenCalledWith("已留存一笔");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("prefills and links the actual retained amount used by a saved expense", async () => {
    const { host } = await renderDialog({
      mode: "release",
      expense: linkedExpense,
      suggestedAmountMinor: 3_500,
    });

    expect(field(host, "其中使用留存").value).toBe("35.00");
    await click(host, "确认取用");
    expect(dataMocks.releaseSavings).toHaveBeenCalledWith({
      amountMinor: 3_500,
      note: "临时支出",
      linkedExpenseEntryId: "expense-1",
    });
  });

  it("creates a direct one-time expense and its linked release together", async () => {
    const { host } = await renderDialog({ mode: "release" });
    await click(host, "直接支出");
    await fill(field(host, "支出总额"), "120.00");
    await fill(field(host, "其中使用留存"), "50.00");
    await fill(field(host, "支出说明"), "更换手机");
    await click(host, "记录支出");

    expect(dataMocks.createSavingsFundedExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "expense",
        amount: "120.00",
        note: "更换手机",
      }),
      5_000,
      undefined,
      expect.any(Date),
      "one_time_expense",
    );
  });

  it("allows a zero-value cycle settlement", async () => {
    const { host } = await renderDialog({
      mode: "settle",
      settlementContext: { ...settlement, suggestedAmountMinor: 0 },
    });
    expect(field(host, "本次再留存").value).toBe("0.00");
    await click(host, "完成结算");

    expect(dataMocks.settleSavingsCycle).toHaveBeenCalledWith({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      goalMinorSnapshot: 10_000,
      amountMinor: 0,
      note: "周期留存结算",
    });
  });

  it("updates the deterministic settlement with corrected amount and target", async () => {
    const correction: SavingsSettlementContext = {
      ...settlement,
      correction: {
        currentAmountMinor: 3_000,
        openingRetainedMinor: 7_000,
        closingRetainedMinor: 10_000,
        netGrowthMinor: 3_000,
        note: "原结算",
        occurredAtLocal: "2026-08-10T09:00",
      },
    };
    const { host, onSaved, onClose } = await renderDialog({
      mode: "settle",
      settlementContext: correction,
      availableMinor: 0n,
    });

    expect(host.querySelector('section[aria-label="更正周期结算"]')).not.toBeNull();
    expect(field(host, "本次再留存").value).toBe("30.00");
    expect(field(host, "本周期目标").value).toBe("100.00");
    expect(field(host, "备注").value).toBe("原结算");
    await fill(field(host, "本次再留存"), "25.00");
    await fill(field(host, "本周期目标"), "120.00");
    await fill(field(host, "备注"), "按实际金额更正");
    await click(host, "保存更正");

    expect(dataMocks.settleSavingsCycle).toHaveBeenCalledWith({
      cycleStartDateKey: "2026-07-10",
      cycleEndDateKey: "2026-08-09",
      goalMinorSnapshot: 12_000,
      amountMinor: 2_500,
      note: "按实际金额更正",
      occurredAtLocal: "2026-08-10T09:00",
    });
    expect(onSaved).toHaveBeenCalledWith("结算已更正");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps corrected settlement input after a save failure", async () => {
    dataMocks.settleSavingsCycle.mockRejectedValueOnce(new Error("本机存储失败"));
    const correction: SavingsSettlementContext = {
      ...settlement,
      correction: {
        currentAmountMinor: 3_000,
        openingRetainedMinor: 7_000,
        closingRetainedMinor: 10_000,
        netGrowthMinor: 3_000,
        note: "原结算",
        occurredAtLocal: "2026-08-10T09:00",
      },
    };
    const { host, onClose } = await renderDialog({
      mode: "settle",
      settlementContext: correction,
    });
    await fill(field(host, "本次再留存"), "40.00");
    await fill(field(host, "本周期目标"), "150.00");
    await click(host, "保存更正");

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("本机存储失败");
    expect(field(host, "本次再留存").value).toBe("40.00");
    expect(field(host, "本周期目标").value).toBe("150.00");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the form and reports when an operation exceeds available money", async () => {
    const { host, onClose } = await renderDialog({
      mode: "reserve",
      availableMinor: 1_000n,
    });
    await fill(field(host, "金额"), "20.00");
    await click(host, "确认留存");

    expect(host.querySelector('[role="alert"]')?.textContent)
      .toContain("留存金额不能超过当前可花资金");
    expect(dataMocks.reserveSavings).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
