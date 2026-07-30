import { expect, test, type Download, type Page } from "@playwright/test";
import { addTextEntry, openLedger } from "./helpers";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function downloadToBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function addScreenshot(page: Page): Promise<void> {
  await page.locator(".composer-panel input[type=file]").setInputFiles({
    name: "receipt.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.getByText("已添加截图", { exact: true })).toBeVisible();
}

test.beforeEach(({ page }, testInfo) => {
  void page;
  test.skip(testInfo.project.name !== "desktop-chrome", "桌面边界流只需执行一次");
});

test("金额存在但缺少文字和截图时保留输入并提示补充说明", async ({ page }) => {
  await openLedger(page);

  await page.getByLabel("金额").fill("18.60");
  await page.getByRole("button", { name: "保存支出" }).click();

  await expect(page.getByText("请填写文字或添加一张截图", { exact: true })).toBeVisible();
  await expect(page.getByLabel("金额")).toHaveValue("18.60");
  await expect(page.getByLabel("这笔是什么")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".record-list article")).toHaveCount(0);
});

test("超过两位小数的金额无效且不会保存", async ({ page }) => {
  await openLedger(page);

  await page.getByLabel("金额").fill("1.234");
  await page.getByLabel("这笔是什么").fill("无效金额记录");
  await page.getByRole("button", { name: "保存支出" }).click();

  await expect(page.getByText("请输入大于 0、最多两位小数的金额", { exact: true })).toBeVisible();
  await expect(page.getByLabel("金额")).toHaveValue("1.234");
  await expect(page.getByLabel("金额")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".record-list").getByText("无效金额记录", { exact: true })).toHaveCount(0);
});

test("仅添加截图也能保存账目", async ({ page }) => {
  await openLedger(page);

  await page.getByLabel("金额").fill("6.50");
  await addScreenshot(page);
  await page.getByRole("button", { name: "保存支出" }).click();

  await expect(page.locator(".record-list").getByText("截图记录", { exact: true })).toBeVisible();
  await expect(page.locator(".record-list img[alt='账目截图']")).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("-¥6.50");
});

test("本机存储用量读取失败时显示明确状态", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, "estimate", {
      configurable: true,
      value: () => Promise.reject(new Error("forced estimate failure")),
    });
  });
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await expect(settings.getByText("读取失败", { exact: true })).toBeVisible();
});

test("加密备份可导出、检查并确认整体恢复", async ({ page }) => {
  const password = "backup-pass-2026";
  await openLedger(page);
  await addTextEntry(page, { amount: "28.80", note: "备份往返记录", kind: "income" });

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByText("导出备份", { exact: true }).click();
  await settings.getByLabel("设置密码").fill(password);
  await settings.getByLabel("再次输入").fill(password);

  const downloadPromise = page.waitForEvent("download");
  await settings.getByRole("button", { name: "下载加密备份" }).click();
  const download = await downloadPromise;
  const backup = await downloadToBuffer(download);
  await expect(settings.getByText("加密备份已下载", { exact: true })).toBeVisible();
  expect(backup.byteLength).toBeGreaterThan(0);

  await settings.getByRole("button", { name: "关闭设置" }).click();
  await addTextEntry(page, { amount: "5.00", note: "恢复前临时记录" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥23.80");

  await page.getByRole("button", { name: "打开设置" }).click();
  const restoreSettings = page.getByRole("dialog", { name: "设置" });
  await restoreSettings.getByText("恢复备份", { exact: true }).click();
  await restoreSettings.getByLabel("备份文件").setInputFiles({
    name: download.suggestedFilename(),
    mimeType: "application/vnd.jiyibi.backup+json",
    buffer: backup,
  });
  await restoreSettings.getByLabel("备份密码").fill("wrong-password");
  await restoreSettings.getByRole("button", { name: "检查备份" }).click();
  await expect(restoreSettings.getByText("密码错误，或备份文件已经损坏", { exact: true })).toBeVisible();
  await expect(restoreSettings.getByRole("region", { name: "确认恢复" })).toHaveCount(0);

  await restoreSettings.getByLabel("备份密码").fill(password);
  await restoreSettings.getByRole("button", { name: "检查备份" }).click();

  const preview = restoreSettings.getByRole("region", { name: "确认恢复" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("1 笔", { exact: true })).toBeVisible();
  await expect(preview.getByText("0 张", { exact: true })).toBeVisible();
  await expect(preview.getByText("¥0.00", { exact: true })).toBeVisible();

  await preview.getByRole("button", { name: "确认覆盖并恢复" }).click();
  await expect(restoreSettings.getByText("备份已恢复，余额和记录已更新", { exact: true })).toBeVisible();
  await restoreSettings.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.getByText("备份往返记录", { exact: true })).toBeVisible();
  await expect(page.getByText("恢复前临时记录", { exact: true })).toHaveCount(0);
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥28.80");
});
