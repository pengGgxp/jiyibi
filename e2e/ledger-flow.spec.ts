import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { addTextEntry, dismissOfflineReady, openLedger } from "./helpers";

test("编辑、初始余额和删除撤销会准确重算", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整变更流只需在桌面项目执行一次");
  await openLedger(page);
  await addTextEntry(page, { amount: "30.00", note: "午餐" });
  await addTextEntry(page, { amount: "12.00", note: "稿费", kind: "income" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("-¥18.00");

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("100.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await expect(settings.getByText("初始余额已更新")).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥82.00");

  await page.getByRole("button", { name: "编辑午餐" }).click();
  const editor = page.getByRole("dialog", { name: "编辑记录" });
  await editor.getByLabel("金额").fill("20.00");
  await editor.getByLabel("这笔是什么").fill("工作餐");
  await editor.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("工作餐", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥92.00");

  await page.getByRole("button", { name: "删除稿费" }).click();
  await expect(page.locator(".record-list").getByText("稿费", { exact: true })).toHaveCount(0);
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥80.00");
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("稿费", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥92.00");
});

test("发薪周期和双收入场景可设置，并在发薪日确认实际收入", async ({ page }) => {
  await openLedger(page);

  await page.getByRole("button", { name: "设置发薪周期" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  const planToggle = settings.getByRole("switch", { name: /打开发薪周期/ });
  const payday = settings.locator("#payday-day");
  const goalAmount = settings.locator("#cycle-end-balance-goal");
  const todayDay = await page.evaluate(() => new Date().getDate());

  await expect(planToggle).not.toBeChecked();
  await expect(payday).toBeDisabled();
  await expect(goalAmount).toBeDisabled();
  await planToggle.check();
  await goalAmount.fill("100.001");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("周期底线请输入有效金额，最多保留两位小数"))
    .toBeVisible();
  await payday.fill(String(todayDay));
  await goalAmount.fill("100.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("发薪周期已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "填写下次收入" }).click();

  const forecastDialog = page.getByRole("dialog", { name: "填写下次收入" });
  await expect(forecastDialog).toBeVisible();
  await forecastDialog.getByLabel("最低收入").fill("1200.00");
  await forecastDialog.getByLabel("预计收入").fill("1000.00");
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog.getByText("最低收入不能高于预计收入", { exact: true }))
    .toBeVisible();
  await forecastDialog.getByLabel("最低收入").fill("600.00");
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog).toBeHidden();
  await expect(page.getByText("下次收入预期已保存", { exact: true })).toBeVisible();

  const outlook = page.locator(".summary-panel");
  await expect(outlook).toContainText("到发薪日");
  await expect(outlook).toContainText("下个工资周期");
  await expect(outlook).toContainText("最低收入 ¥600.00");
  await expect(outlook).toContainText("预计收入 ¥1,000.00");
  await expect(outlook).toContainText("暂不判断");
  await expect(outlook).toContainText("每日可花");
  const reminder = page.locator(".income-reminder");
  await expect(reminder).toContainText("今天是发薪日，记一下实际收入");
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);

  await reminder.getByRole("button", { name: "填写实际收入" }).click();
  const actualDialog = page.getByRole("dialog", { name: "填写实际收入" });
  await expect(actualDialog.getByLabel("实际到账总额")).toHaveValue("1000.00");
  await actualDialog.getByRole("button", { name: "记入实际收入" }).click();
  await expect(actualDialog).toBeHidden();
  await expect(page.getByText("本次实际收入", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥1,000.00");
  await expect(reminder).toHaveCount(0);
  await expect(outlook.getByRole("button", { name: /填写下次收入/ })).toBeVisible();

  await page.getByRole("link", { name: "查看详细分析" }).click();
  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await expect(page.getByText("还差 14 个完整日", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "记账" }).click();

  await addTextEntry(page, { amount: "40.00", note: "目标测试收入", kind: "income" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥1,040.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "记一笔" })).toBeVisible();
  await dismissOfflineReady(page);
  await expect(page.getByText("目标测试收入", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel")).toContainText("下个工资周期");
});

test("键盘可进入主内容，对话框可用 Escape 关闭并恢复焦点", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "键盘流只需在桌面项目执行一次");
  await openLedger(page);

  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.locator("#main-content")).toBeFocused();

  const settingsButton = page.getByRole("button", { name: "打开设置" });
  await settingsButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "设置" })).toBeHidden();
  await expect(settingsButton).toBeFocused();

  await addTextEntry(page, { amount: "8.00", note: "键盘记录" });
  const editButton = page.getByRole("button", { name: "编辑键盘记录" });
  await editButton.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "编辑记录" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("金额")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(editButton).toBeFocused();

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("预缓存后离线重载仍可新增并持久化", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "离线能力只需在一个 Chromium 项目执行一次");
  await openLedger(page);
  await addTextEntry(page, { amount: "16.00", note: "在线记录" });

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Service Worker 未接管页面")), 10_000);
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.clearTimeout(timer);
          resolve();
        }, { once: true });
        void registration.update();
      });
    }
  });

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("在线记录", { exact: true })).toBeVisible();
    await dismissOfflineReady(page);

    await addTextEntry(page, { amount: "9.50", note: "离线记录" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("在线记录", { exact: true })).toBeVisible();
    await expect(page.getByText("离线记录", { exact: true })).toBeVisible();
    await expect(page.locator(".summary-panel .balance-value")).toHaveText("-¥25.50");
  } finally {
    await context.setOffline(false);
  }
});
