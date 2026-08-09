import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useLedger } from "./useLedger";

vi.mock("dexie", () => ({
  liveQuery: (query: () => Promise<unknown>) => ({
    subscribe(observer: { next(value: unknown): void; error(reason: unknown): void }) {
      let active = true;
      void query().then(
        (value) => { if (active) observer.next(value); },
        (reason) => { if (active) observer.error(reason); },
      );
      return { unsubscribe: () => { active = false; } };
    },
  }),
}));

vi.mock("../data", () => ({
  getSettings: vi.fn(async () => ({
    id: "primary",
    currency: "CNY",
    initialBalanceMinor: 0,
    monthEndBalanceGoalMinor: 10_000,
    schemaVersion: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
  })),
  listActiveEntries: vi.fn(async () => []),
}));

const roots: Root[] = [];
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
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mountProbe(): Promise<() => number> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  let renders = 0;

  function Probe() {
    useLedger();
    renders += 1;
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  return () => renders;
}

describe("useLedger local date refresh", () => {
  it("rerenders after local midnight even within the same month", async () => {
    vi.setSystemTime(new Date(2026, 7, 10, 23, 59, 59, 500));
    const renders = await mountProbe();
    const beforeMidnight = renders();

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(renders()).toBeGreaterThan(beforeMidnight);
  });

  it("catches up when a suspended tab becomes visible on a later date", async () => {
    vi.setSystemTime(new Date(2026, 7, 10, 12));
    const renders = await mountProbe();
    const beforeRestore = renders();
    vi.setSystemTime(new Date(2026, 7, 11, 12));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(renders()).toBeGreaterThan(beforeRestore);
  });
});
