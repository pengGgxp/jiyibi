import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LedgerEntry, RecoveryAllocation } from "../domain";
import { RecordList } from "./RecordList";

vi.mock("./Modal", () => ({
  Modal: ({ open, title, description, children }: {
    open: boolean;
    title: string;
    description?: string;
    children: ReactNode;
  }) => open ? <section aria-label={title}>{description ? <p>{description}</p> : null}{children}</section> : null,
}));

function entry(id: string, treatment: LedgerEntry["treatment"], amountMinor = -10_000): LedgerEntry {
  return {
    id,
    amountMinor,
    note: id,
    occurredAt: "2026-08-20T04:00:00.000Z",
    localDateKey: "2026-08-20",
    localMonthKey: "2026-08",
    timezoneOffsetMinutes: -480,
    treatment,
    confirmationStatus: "confirmed",
    createdAt: "2026-08-20T04:00:00.000Z",
    updatedAt: "2026-08-20T04:00:00.000Z",
  };
}

function allocation(id: string, expenseEntryId: string, amountMinor: number): RecoveryAllocation {
  return {
    id,
    refundEntryId: `refund-${id}`,
    expenseEntryId,
    amountMinor,
    createdAt: "2026-08-20T05:00:00.000Z",
    updatedAt: "2026-08-20T05:00:00.000Z",
  };
}

const roots: Root[] = [];
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => { reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => {
  if (previousActEnvironment === undefined) Reflect.deleteProperty(reactEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  else reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

async function renderList(
  entries: LedgerEntry[],
  allocations: RecoveryAllocation[],
  onCloseReimbursement = vi.fn(),
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(
    <RecordList
      entries={entries}
      recoveryAllocations={allocations}
      loading={false}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onCloseReimbursement={onCloseReimbursement}
      onStartEntry={vi.fn()}
    />,
  ));
  return { host, onCloseReimbursement };
}

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Element was not rendered");
  await act(async () => element.click());
}

describe("RecordList reimbursement status", () => {
  it("shows periodic, one-time, pending reimbursement, reimbursed and personal-cost labels", async () => {
    const entries = [
      entry("periodic", "periodic_expense"),
      entry("one-time", "one_time_expense", -20_000),
      entry("waiting", "reimbursable_expense", -100_000),
      entry("covered", "reimbursable_expense", -50_000),
    ];
    const { host } = await renderList(entries, [
      allocation("one-part", "one-time", 5_000),
      allocation("waiting-part", "waiting", 80_000),
      allocation("covered-all", "covered", 50_000),
    ]);

    expect(host.textContent).toContain("周期账单");
    expect(host.textContent).toContain("仅这一次 · 自付 ¥150.00");
    expect(host.textContent).toContain("待报 ¥200.00");
    expect(host.textContent).toContain("已报销");
  });

  it("closes a partial reimbursement into one final expense treatment", async () => {
    const onCloseReimbursement = vi.fn().mockResolvedValue(undefined);
    const { host } = await renderList(
      [entry("waiting", "reimbursable_expense", -100_000)],
      [allocation("partial", "waiting", 80_000)],
      onCloseReimbursement,
    );

    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "结束报销") ?? null);
    expect(host.querySelector('[aria-label="结束报销"]')).not.toBeNull();
    expect(host.textContent).toContain("未报 ¥200.00");

    await click(host.querySelector('input[value="periodic_expense"]'));
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "确认结束") ?? null);
    expect(onCloseReimbursement).toHaveBeenCalledWith("waiting", "periodic_expense");
  });
});
