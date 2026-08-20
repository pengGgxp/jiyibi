import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

const roots: Root[] = [];
const reactEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
const originalRequestAnimationFrame = window.requestAnimationFrame;

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
  };
  window.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
});

afterAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
  window.requestAnimationFrame = originalRequestAnimationFrame;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe("Modal", () => {
  it("blocks every dismiss path while closing is disabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <Modal open title="处理中" closeDisabled onClose={onClose}>
          <p>正在保存</p>
        </Modal>,
      );
    });

    const dialog = host.querySelector("dialog");
    const closeButton = host.querySelector<HTMLButtonElement>('button[aria-label="关闭处理中"]');
    expect(dialog).not.toBeNull();
    expect(closeButton?.disabled).toBe(true);

    await act(async () => {
      closeButton?.click();
      dialog?.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }));
      dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
