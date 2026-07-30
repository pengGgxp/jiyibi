import { expect, type Page } from "@playwright/test";

export async function openLedger(page: Page): Promise<void> {
  await page.goto("./", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "记一笔" })).toBeVisible();
  await dismissOfflineReady(page);
}

export async function dismissOfflineReady(page: Page): Promise<void> {
  const notice = page.getByRole("button", { name: "已可离线使用" });
  if (await notice.isVisible()) await notice.click();
}

export async function addTextEntry(
  page: Page,
  options: { amount: string; note: string; kind?: "expense" | "income" },
): Promise<void> {
  if (options.kind === "income") await page.getByLabel("收入").click();
  await page.getByLabel("金额").fill(options.amount);
  await page.getByLabel("这笔是什么").fill(options.note);
  await page
    .getByRole("button", { name: options.kind === "income" ? "保存收入" : "保存支出" })
    .click();
  await expect(page.getByText(options.note, { exact: true })).toBeVisible();
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}
