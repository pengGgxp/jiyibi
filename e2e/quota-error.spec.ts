import { expect, test } from "@playwright/test";
import { openLedger } from "./helpers";

test("配额不足时显示明确错误并保留全部输入", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "存储异常流只需在桌面项目执行一次");
  await openLedger(page);

  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    Object.defineProperty(IDBObjectStore.prototype, "add", {
      configurable: true,
      value(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
        if (this.name === "entries") {
          throw new DOMException("forced quota failure", "QuotaExceededError");
        }
        return originalAdd.apply(this, args);
      },
    });
  });

  await page.getByLabel("金额").fill("99.00");
  await page.getByLabel("这笔是什么").fill("空间不足记录");
  await page.getByRole("button", { name: "保存支出" }).click();

  await expect(page.getByRole("alert")).toContainText("本机存储空间不足");
  await expect(page.getByLabel("金额")).toHaveValue("99.00");
  await expect(page.getByLabel("这笔是什么")).toHaveValue("空间不足记录");
  await expect(page.locator(".records-section article")).toHaveCount(0);
});
