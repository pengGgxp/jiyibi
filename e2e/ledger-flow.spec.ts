import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { addTextEntry, dismissOfflineReady, openLedger } from "./helpers";

test("编辑、初始余额和删除撤销会准确重算", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整变更流只需在桌面项目执行一次");
  await openLedger(page);
  await addTextEntry(page, { amount: "30.00", note: "午餐" });
  await addTextEntry(page, { amount: "12.00", note: "稿费", kind: "income" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥0.00");
  await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
    .toHaveText("-¥18.00");

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

test("大额支出保存后可稍后确认，并在刷新后保持处理方式", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "确认流只需在移动端执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("switch", { name: /启用发薪日/ }).check();
  await settings.locator("#payday-day").fill(String(await page.evaluate(() => new Date().getDate())));
  await settings.getByRole("button", { name: "保存发薪日" }).click();
  await expect(settings.getByText("发薪日已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "800.00", note: "一次性设备" });
  const prompt = page.getByRole("dialog", { name: "这笔支出会明显影响估算" });
  const totalBalance = page.locator(".summary-savings-grid div")
    .filter({ hasText: "总余额" })
    .locator("dd");
  await expect(prompt).toBeVisible();
  await expect(page.getByText("一次性设备", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥0.00");
  await expect(totalBalance).toHaveText("-¥800.00");

  await prompt.getByRole("button", { name: "稍后处理" }).click();
  await expect(prompt).toBeHidden();
  const pending = page.locator(".income-reminder").filter({ hasText: "交易待确认" });
  await expect(pending).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  await expect(pending).toBeVisible();
  await pending.getByRole("button", { name: "去确认" }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("radio", { name: /仅这一次/ }).check();
  await prompt.getByRole("button", { name: "确认" }).click();
  await expect(prompt).toBeHidden();
  await expect(pending).toHaveCount(0);

  await page.getByRole("link", { name: "详细分析" }).click();
  const keyData = page.getByRole("region", { name: "关键数据" });
  await expect(keyData).toContainText("本月支出");
  await expect(keyData).toContainText("¥800.00");
  await expect(page.getByRole("region", { name: "每日支出" })).toContainText("暂无完整日数据");
  await page.getByRole("link", { name: "记账" }).click();

  const record = page.getByRole("article").filter({ hasText: "一次性设备" });
  await expect(record).toContainText("支出 · 一次性");
  await expect(totalBalance).toHaveText("-¥800.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: "一次性设备" }))
    .toContainText("支出 · 一次性");
  await expect(totalBalance).toHaveText("-¥800.00");
});

test("发薪日和单一预计收入可设置，实际收入确认后保留下次预填", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整收入流只需在桌面项目执行一次");
  await openLedger(page);

  const dates = await page.evaluate(() => {
    const dateKey = (date: Date) => [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
    const goalDate = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate(), 12);
    return {
      todayDay: today.getDate(),
      todayDateKey: dateKey(today),
      tomorrowDateKey: dateKey(tomorrow),
      goalDateKey: dateKey(goalDate),
    };
  });

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  const planToggle = settings.getByRole("switch", { name: /启用发薪日/ });
  const payday = settings.locator("#payday-day");
  await expect(planToggle).not.toBeChecked();
  await expect(payday).toBeDisabled();
  await planToggle.check();
  await payday.fill("32");
  await settings.getByRole("button", { name: "保存发薪日" }).click();
  await expect(settings.getByText("请输入 1 到 31", { exact: true })).toBeVisible();
  await payday.fill(String(dates.todayDay));
  await settings.getByRole("button", { name: "保存发薪日" }).click();
  await expect(settings.getByText("发薪日已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "填写预计" }).click();

  const forecastDialog = page.getByRole("dialog", { name: "下次收入" });
  await expect(forecastDialog).toBeVisible();
  await forecastDialog.getByRole("radio", { name: /改日期/ }).check();
  await forecastDialog.getByLabel("选择日期").fill(dates.todayDateKey);
  await forecastDialog.getByLabel("预计额").fill("1000.00");
  await forecastDialog.getByRole("button", { name: "保存预计" }).click();
  await expect(forecastDialog).toBeHidden();
  await expect(page.getByText("预计收入已保存", { exact: true })).toBeVisible();

  const summary = page.locator(".summary-panel");
  await expect(summary).toContainText("到下次");
  await expect(summary).toContainText("下次收入");
  await expect(summary).toContainText("¥1,000.00");
  await expect(summary).not.toContainText("最低收入");
  await expect(summary).not.toContainText("每日可花");
  const reminder = page.locator(".income-reminder").filter({ hasText: "今天是预计到账日" });
  await expect(reminder).toBeVisible();

  await reminder.getByRole("button", { name: "延期到账" }).click();
  const postponeDialog = page.getByRole("dialog", { name: "延期到账" });
  await postponeDialog.getByLabel("到账日").fill(dates.tomorrowDateKey);
  await postponeDialog.getByRole("button", { name: "保存日期" }).click();
  await expect(postponeDialog).toBeHidden();
  await expect(reminder).toHaveCount(0);

  await page.getByRole("button", { name: "设置目标" }).click();
  const goalDialog = page.getByRole("dialog", { name: "存钱目标" });
  await goalDialog.getByLabel("目标额").fill("500.00");
  await goalDialog.getByLabel("截止日").fill(dates.goalDateKey);
  await goalDialog.getByRole("button", { name: "保存目标" }).click();
  await expect(goalDialog).toBeHidden();
  await expect(summary.getByRole("progressbar", { name: "存钱目标进度" }))
    .toHaveAttribute("aria-valuetext", "已存 ¥0.00，目标 ¥500.00");

  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(payday).toHaveValue(String(dates.todayDay));
  await settings.getByRole("button", { name: "修改预计" }).click();
  await forecastDialog.getByLabel("选择日期").fill(dates.todayDateKey);
  await forecastDialog.getByRole("button", { name: "保存预计" }).click();
  await expect(reminder).toBeVisible();

  await reminder.getByRole("button", { name: "填写实际收入" }).click();
  const actualDialog = page.getByRole("dialog", { name: "实际收入" });
  await expect(actualDialog.getByLabel("实际额")).toHaveValue("1000.00");
  await expect(actualDialog.getByLabel("到账日")).toHaveValue(dates.todayDateKey);
  await expect(actualDialog.getByText("本次再留存")).toHaveCount(0);
  await actualDialog.getByRole("button", { name: "确认收入" }).click();
  await expect(actualDialog).toBeHidden();
  await expect(page.getByText("本次实际收入", { exact: true })).toBeVisible();
  await expect(summary.locator(".balance-value")).toHaveText("¥1,000.00");
  await expect(reminder).toHaveCount(0);
  await expect(summary).toContainText("¥0.00 / ¥500.00");

  const nextForecastButton = summary.getByRole("button", { name: "填写" });
  await expect(nextForecastButton).toBeVisible();
  await nextForecastButton.click();
  await expect(forecastDialog.getByLabel("预计额")).toHaveValue("1000.00");
  await expect(forecastDialog.getByRole("radio", { name: /常规日/ })).toBeChecked();
  await expect(forecastDialog.locator("#income-target-date")).toHaveCount(0);
  await forecastDialog.getByRole("button", { name: "取消" }).click();
  await expect(summary).toContainText("下次收入未填写");

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(summary).toContainText("¥0.00 / ¥500.00");
  await summary.getByRole("button", { name: "填写" }).click();
  await expect(forecastDialog.getByLabel("预计额")).toHaveValue("1000.00");
});

test("存钱目标、存入和取用跨刷新保持，目标不预扣可花余额", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整存钱流只需在桌面项目执行一次");
  await openLedger(page);

  const goalDateKey = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 90);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  });

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("300.00");
  await settings.getByRole("button", { name: "保存存款" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  const summary = page.locator(".summary-panel");
  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已存¥300.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥700.00");

  await summary.getByRole("button", { name: "设置目标" }).click();
  const goalDialog = page.getByRole("dialog", { name: "存钱目标" });
  await goalDialog.getByLabel("目标额").fill("500.00");
  await goalDialog.getByLabel("截止日").fill(goalDateKey);
  await goalDialog.getByRole("button", { name: "保存目标" }).click();
  await expect(summary).toContainText("¥300.00 / ¥500.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥700.00");

  await summary.getByRole("button", { name: "存一笔" }).click();
  const reserveDialog = page.getByRole("dialog", { name: "存一笔" });
  await reserveDialog.getByLabel("金额").fill("50.00");
  await reserveDialog.getByLabel("备注（可选）").fill("目标存款");
  await reserveDialog.getByRole("button", { name: "确认存入" }).click();
  await expect(reserveDialog).toBeHidden();
  await expect(summary).toContainText("已存¥350.00");
  await expect(summary).toContainText("¥350.00 / ¥500.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥650.00");

  await summary.getByRole("button", { name: "取用" }).click();
  const releaseDialog = page.getByRole("dialog", { name: "取用存款" });
  await expect(releaseDialog.getByRole("button", { name: "转为可花" }))
    .toHaveAttribute("aria-pressed", "true");
  await releaseDialog.getByLabel("金额").fill("25.00");
  await releaseDialog.getByLabel("备注（可选）").fill("临时取用");
  await releaseDialog.getByRole("button", { name: "确认取用" }).click();
  await expect(releaseDialog).toBeHidden();
  await expect(summary).toContainText("已存¥325.00");
  await expect(summary).toContainText("¥325.00 / ¥500.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥675.00");
  await expect(page.locator(".record-list li")).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已存¥325.00");
  await expect(summary).toContainText("¥325.00 / ¥500.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥675.00");
});

test("部分取用和关联支出删除撤销会联动更新", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "关联支出流只需在桌面项目执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("300.00");
  await settings.getByRole("button", { name: "保存存款" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  const summary = page.locator(".summary-panel");
  await summary.getByRole("button", { name: "存一笔" }).click();
  const reserveDialog = page.getByRole("dialog", { name: "存一笔" });
  await reserveDialog.getByLabel("金额").fill("50.00");
  await reserveDialog.getByLabel("备注（可选）").fill("追加存款");
  await reserveDialog.getByRole("button", { name: "确认存入" }).click();
  await expect(summary).toContainText("已存¥350.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥650.00");

  await summary.getByRole("button", { name: "取用" }).click();
  const releaseDialog = page.getByRole("dialog", { name: "取用存款" });
  await releaseDialog.getByRole("button", { name: "直接支出" }).click();
  await releaseDialog.getByLabel("支出总额").fill("200.00");
  await releaseDialog.getByLabel("使用存款").fill("100.00");
  await releaseDialog.getByLabel("支出说明").fill("临时设备");
  await releaseDialog.getByRole("button", { name: "记录支出" }).click();
  await expect(releaseDialog).toBeHidden();
  await expect(page.getByText("临时设备", { exact: true })).toBeVisible();
  await expect(summary).toContainText("总余额¥800.00");
  await expect(summary).toContainText("已存¥250.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥550.00");

  await page.getByRole("button", { name: "删除临时设备" }).click();
  await expect(page.locator(".record-list").getByText("临时设备", { exact: true })).toHaveCount(0);
  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已存¥350.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥650.00");
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("临时设备", { exact: true })).toBeVisible();
  await expect(summary).toContainText("总余额¥800.00");
  await expect(summary).toContainText("已存¥250.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥550.00");
});

test("支出穿透存款时预填实际缺口，账户转账不会误提示", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "穿透确认流只需在移动端执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("100.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("80.00");
  await settings.getByRole("button", { name: "保存存款" }).click();
  await settings.getByRole("switch", { name: /启用发薪日/ }).check();
  await settings.locator("#payday-day").fill("28");
  await settings.getByRole("button", { name: "保存发薪日" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "50.00", note: "动用测试" });
  const savingsPrompt = page.getByRole("dialog", { name: "确认取用" });
  await expect(savingsPrompt).toBeVisible();
  await expect(savingsPrompt.getByLabel("使用存款")).toHaveValue("30.00");
  await savingsPrompt.getByRole("button", { name: "确认取用", exact: true }).click();
  await expect(savingsPrompt).toBeHidden();
  await expect(page.locator(".summary-panel")).toContainText("已存¥50.00");

  await page.getByRole("button", { name: "打开设置" }).click();
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("800.00");
  await settings.getByRole("button", { name: "保存存款" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "800.00", note: "账户调拨" });
  const treatment = page.getByRole("dialog", { name: "这笔支出会明显影响估算" });
  await expect(treatment).toBeVisible();
  await treatment.getByRole("radio", { name: /自己的账户间转账/ }).check();
  await treatment.getByRole("button", { name: "确认", exact: true }).click();
  await expect(treatment).toBeHidden();
  await expect(savingsPrompt).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: "账户调拨" }))
    .toContainText("账户间转账");
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
    await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥0.00");
    await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
      .toHaveText("-¥25.50");
  } finally {
    await context.setOffline(false);
  }
});
