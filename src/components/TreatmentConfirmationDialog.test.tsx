import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../domain";
import { TreatmentConfirmationDialog } from "./TreatmentConfirmationDialog";

const modalState = vi.hoisted(() => ({
  onClose: undefined as (() => void) | undefined,
  closeDisabled: false,
}));

vi.mock("./Modal", () => ({
  Modal: ({
    title,
    description,
    closeDisabled = false,
    onClose,
    children,
  }: {
    title: string;
    description?: string;
    closeDisabled?: boolean;
    onClose(): void;
    children: ReactNode;
  }) => {
    modalState.onClose = onClose;
    modalState.closeDisabled = closeDisabled;
    return (
      <section aria-label={title}>
        {description ? <p>{description}</p> : null}
        {children}
      </section>
    );
  },
}));

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: "entry-1",
    amountMinor: -80_000,
    note: "设备",
    occurredAt: "2026-08-10T04:00:00.000Z",
    localDateKey: "2026-08-10",
    localMonthKey: "2026-08",
    timezoneOffsetMinutes: -480,
    treatment: "ordinary_expense",
    confirmationStatus: "not_needed",
    createdAt: "2026-08-10T04:00:00.000Z",
    updatedAt: "2026-08-10T04:00:00.000Z",
    ...overrides,
  };
}

const roots: Root[] = [];
const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  if (previousActEnvironment === undefined) {
    Reflect.deleteProperty(reactEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  } else {
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  modalState.onClose = undefined;
  modalState.closeDisabled = false;
  document.body.replaceChildren();
});

async function renderDialog(props: {
  entry?: LedgerEntry;
  kind?: "expense" | "income";
  busy?: boolean;
  error?: string;
} = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onConfirm = vi.fn();
  const onDefer = vi.fn();

  await act(async () => {
    root.render(
      <TreatmentConfirmationDialog
        entry={Object.hasOwn(props, "entry") ? props.entry : entry()}
        kind={props.kind ?? "expense"}
        busy={props.busy}
        error={props.error}
        onConfirm={onConfirm}
        onDefer={onDefer}
        onClose={vi.fn()}
      />,
    );
  });
  return { host, onConfirm, onDefer };
}

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Element was not rendered");
  await act(async () => element.click());
}

describe("TreatmentConfirmationDialog", () => {
  it("shows expense choices and confirms the selected treatment", async () => {
    const { host, onConfirm } = await renderDialog();
    const labels = [...host.querySelectorAll("strong")].map((node) => node.textContent);
    expect(labels).toEqual(["周期账单", "仅这一次", "之后报销"]);
    expect(host.querySelector("fieldset legend")?.textContent).toBe("特殊支出类型");
    expect(host.querySelector('input[value="ordinary_expense"]')).toBeNull();
    expect(host.textContent).not.toContain("账户间转账");

    await click(host.querySelector('input[value="periodic_expense"]'));
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "确认") ?? null);
    expect(onConfirm).toHaveBeenCalledWith("periodic_expense");
  });

  it("keeps ordinary expense as a quiet exit action", async () => {
    const { host, onConfirm } = await renderDialog();
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "按日常算") ?? null);
    expect(onConfirm).toHaveBeenCalledWith("ordinary_expense");
  });

  it("shows income choices and restores an existing treatment", async () => {
    const { host } = await renderDialog({
      kind: "income",
      entry: entry({ amountMinor: 12_345, treatment: "refund_reimbursement" }),
    });
    const labels = [...host.querySelectorAll("strong")].map((node) => node.textContent);
    expect(labels).toEqual(["收入", "退款或报销"]);
    expect(host.textContent).not.toContain("账户间转账");
    expect(host.querySelector<HTMLInputElement>('input[value="refund_reimbursement"]')?.checked)
      .toBe(true);
  });

  it("defers from both the action and modal close", async () => {
    const { host, onDefer } = await renderDialog();
    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "稍后处理") ?? null);
    expect(onDefer).toHaveBeenCalledOnce();

    modalState.onClose?.();
    expect(onDefer).toHaveBeenCalledTimes(2);
  });

  it("disables controls while saving and exposes errors", async () => {
    const { host, onConfirm, onDefer } = await renderDialog({ busy: true, error: "处理方式没有保存" });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("处理方式没有保存");
    expect([...host.querySelectorAll("input, button")].every((control) => (
      (control as HTMLInputElement | HTMLButtonElement).disabled
    ))).toBe(true);
    expect(host.textContent).toContain("保存中…");

    await click([...host.querySelectorAll("button")].find((button) => button.textContent === "保存中…") ?? null);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(modalState.closeDisabled).toBe(true);
    modalState.onClose?.();
    expect(onDefer).not.toHaveBeenCalled();
  });

  it("renders nothing without an entry", async () => {
    const { host } = await renderDialog({ entry: undefined });
    expect(host.childElementCount).toBe(0);
  });
});
