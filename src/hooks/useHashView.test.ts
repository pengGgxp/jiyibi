import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseAppView, useHashView } from "./useHashView";

const mounted: Array<() => Promise<void>> = [];
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

afterEach(async () => {
  while (mounted.length) await mounted.pop()?.();
  window.history.replaceState(null, "", "/");
});

async function renderView(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ViewProbe));
  });
  mounted.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}

function ViewProbe() {
  const [view] = useHashView();
  return createElement("span", { "data-view": view }, view);
}

describe("parseAppView", () => {
  it("recognises the analysis view", () => {
    expect(parseAppView("#analysis")).toBe("analysis");
    expect(parseAppView("#ANALYSIS")).toBe("analysis");
  });

  it("falls back to the ledger view for an empty or unknown hash", () => {
    expect(parseAppView("")).toBe("ledger");
    expect(parseAppView("#ledger")).toBe("ledger");
    expect(parseAppView("#main-content")).toBe("ledger");
    expect(parseAppView("#unknown")).toBe("ledger");
  });

  it("normalises the bare URL and follows hash navigation", async () => {
    window.history.replaceState(null, "", "/jiyibi/?source=test");
    const host = await renderView();

    expect(window.location.pathname).toBe("/jiyibi/");
    expect(window.location.search).toBe("?source=test");
    expect(window.location.hash).toBe("#ledger");
    expect(host.querySelector("[data-view]")?.textContent).toBe("ledger");

    await act(async () => {
      window.location.hash = "analysis";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(host.querySelector("[data-view]")?.textContent).toBe("analysis");
  });

  it("replaces unknown hashes with the ledger route", async () => {
    window.history.replaceState(null, "", "/jiyibi/#old-bookmark");
    const host = await renderView();

    expect(window.location.hash).toBe("#ledger");
    expect(host.querySelector("[data-view]")?.textContent).toBe("ledger");
  });
});
