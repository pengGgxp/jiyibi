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
  await settings.getByRole("switch", { name: /打开发薪周期/ }).check();
  await settings.locator("#payday-day").fill(String(await page.evaluate(() => new Date().getDate())));
  await settings.locator("#default-savings-target").fill("0.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("发薪周期已更新", { exact: true })).toBeVisible();
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

  await expect(page.getByRole("link", { name: "查看详细分析" })).toBeVisible();
  await page.getByRole("link", { name: "查看详细分析" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "实际现金流" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "日常花法" })).toBeVisible();
  const cashflow = page.locator(".analysis-metrics-section").filter({ has: page.getByRole("heading", { name: "实际现金流" }) });
  const baseline = page.locator(".analysis-metrics-section").filter({ has: page.getByRole("heading", { name: "日常花法" }) });
  await expect(cashflow).toContainText("本月支出");
  await expect(cashflow).toContainText("¥800.00");
  const includedBaseline = baseline.locator(".analysis-metric").filter({ hasText: "纳入日常花法" });
  await expect(includedBaseline.locator("dt")).toHaveText("纳入日常花法");
  await expect(includedBaseline.locator("dd").first()).toHaveText("¥0.00");
  await page.getByRole("link", { name: "记账" }).click();

  const record = page.getByRole("article").filter({ hasText: "一次性设备" });
  await expect(record).toContainText("支出 · 一次性");
  await expect(totalBalance).toHaveText("-¥800.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  const reloadedRecord = page.getByRole("article").filter({ hasText: "一次性设备" });
  await expect(reloadedRecord).toContainText("支出 · 一次性");
  await expect(totalBalance).toHaveText("-¥800.00");
});

test("发薪周期和双收入场景可设置，并在发薪日确认实际收入", async ({ page }) => {
  await openLedger(page);

  await page.getByRole("button", { name: "设置发薪周期" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  const planToggle = settings.getByRole("switch", { name: /打开发薪周期/ });
  const payday = settings.locator("#payday-day");
  const goalAmount = settings.locator("#default-savings-target");
  const todayDay = await page.evaluate(() => new Date().getDate());
  const todayDateKey = await page.evaluate(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  });
  const tomorrowDateKey = await page.evaluate(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  });

  await expect(planToggle).not.toBeChecked();
  await expect(payday).toBeDisabled();
  await expect(goalAmount).toBeDisabled();
  await planToggle.check();
  await goalAmount.fill("100.001");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("默认留存目标请输入有效金额，最多保留两位小数"))
    .toBeVisible();
  await payday.fill(String(todayDay));
  await goalAmount.fill("0.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("发薪周期已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "填写下次收入" }).click();

  const forecastDialog = page.getByRole("dialog", { name: "填写下次收入" });
  await expect(forecastDialog).toBeVisible();
  await forecastDialog.getByLabel("本次预计到账日").fill(todayDateKey);
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
  await expect(reminder).toContainText("今天是预计到账日，记一下实际收入");
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);

  await reminder.getByRole("button", { name: "延期到账" }).click();
  await expect(forecastDialog).toBeVisible();
  await forecastDialog.getByLabel("本次预计到账日").fill(tomorrowDateKey);
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog).toBeHidden();
  await expect(reminder).toHaveCount(0);

  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(payday).toHaveValue(String(todayDay));
  await settings.getByRole("button", { name: "修改收入预期" }).click();
  await expect(forecastDialog).toBeVisible();
  await forecastDialog.getByLabel("本次预计到账日").fill(todayDateKey);
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog).toBeHidden();
  await expect(reminder).toContainText("今天是预计到账日，记一下实际收入");

  await reminder.getByRole("button", { name: "填写实际收入" }).click();
  const actualDialog = page.getByRole("dialog", { name: "填写实际收入" });
  await expect(actualDialog.getByLabel("实际到账总额")).toHaveValue("1000.00");
  await actualDialog.getByRole("button", { name: "记入实际收入" }).click();
  await expect(actualDialog).toBeHidden();
  await expect(page.getByText("本次实际收入", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥1,000.00");
  await expect(reminder).toHaveCount(0);
  const nextForecastButton = outlook.getByRole("button", { name: /填写下次收入/ });
  await expect(nextForecastButton).toBeVisible();
  await nextForecastButton.click();
  await expect(forecastDialog).toBeVisible();
  await expect(forecastDialog.getByLabel("本次预计到账日")).not.toHaveValue(todayDateKey);
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog).toBeHidden();
  await expect(reminder).toHaveCount(0);

  await page.getByRole("link", { name: "查看详细分析" }).click();
  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await expect(page.getByText("数据覆盖还差 14 天", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "记账" }).click();

  await addTextEntry(page, { amount: "40.00", note: "目标测试收入", kind: "income" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥1,040.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "记一笔" })).toBeVisible();
  await dismissOfflineReady(page);
  await expect(page.getByText("目标测试收入", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel")).toContainText("下个工资周期");
});

test("实际收入结算可新增留存并清除本周期目标覆盖", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "收入与留存原子结算只需在桌面项目执行一次");
  await openLedger(page);

  const today = await page.evaluate(() => {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return {
      day: now.getDate(),
      dateKey: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    };
  });

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("200.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.getByRole("switch", { name: /打开发薪周期/ }).check();
  await settings.locator("#payday-day").fill(String(today.day));
  await settings.locator("#default-savings-target").fill("100.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await expect(settings.getByText("发薪周期已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "填写下次收入" }).click();

  const forecastDialog = page.getByRole("dialog", { name: "填写下次收入" });
  await forecastDialog.getByLabel("本次预计到账日").fill(today.dateKey);
  await forecastDialog.getByLabel("最低收入").fill("600.00");
  await forecastDialog.getByLabel("预计收入").fill("1000.00");
  await forecastDialog.getByRole("button", { name: "保存收入预期" }).click();
  await expect(forecastDialog).toBeHidden();

  await page.getByRole("button", { name: "打开设置" }).click();
  await settings.locator("#cycle-savings-target").fill("150.00");
  await settings.getByRole("button", { name: "保存本周期目标" }).click();
  await expect(settings.getByText("本周期目标已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  const summary = page.locator(".summary-panel");
  await expect(summary).toContainText("本周期目标¥150.00");
  const reminder = page.locator(".income-reminder").filter({ hasText: "今天是预计到账日" });
  await reminder.getByRole("button", { name: "填写实际收入" }).click();
  const actualDialog = page.getByRole("dialog", { name: "填写实际收入" });
  await expect(actualDialog.getByLabel("实际到账总额")).toHaveValue("1000.00");
  await expect(actualDialog.getByLabel("本次再留存")).toHaveValue("150.00");
  await actualDialog.getByLabel("本次再留存").fill("120.00");
  await actualDialog.getByRole("button", { name: "记入实际收入" }).click();
  await expect(actualDialog).toBeHidden();

  await expect(page.getByText("本次实际收入", { exact: true })).toBeVisible();
  await expect(summary).toContainText("总余额¥1,200.00");
  await expect(summary).toContainText("已留存¥120.00");
  await expect(summary).toContainText("本周期目标¥100.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥980.00");
  await expect(reminder).toHaveCount(0);

  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(settings.locator("#cycle-savings-target")).toHaveValue("");
  await expect(settings.getByText("尚未填写", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3, name: "本周期留存" })).toBeVisible();
  await expect(page.locator(".analysis-savings-metrics")).toContainText("当前已留存¥120.00");

  const savingsDetailsToggle = page.locator('summary[aria-label="留存明细：查看记录"]');
  await savingsDetailsToggle.click();
  const savingsDetailsTable = page.locator("table").filter({
    has: page.locator("caption", { hasText: "留存明细" }),
  });
  await expect(savingsDetailsTable).toBeVisible();
  await expect(savingsDetailsTable.getByRole("row", { name: /周期结算 \+¥120\.00/ })).toBeVisible();

  const savingsHistoryToggle = page.locator('summary[aria-label="完整周期留存：查看数据表"]');
  await savingsHistoryToggle.click();
  const savingsHistoryTable = page.locator("table").filter({
    has: page.locator("caption", { hasText: "完整周期留存" }),
  });
  await expect(savingsHistoryTable).toBeVisible();
  await expect(savingsHistoryTable.getByRole("row", { name: /¥150\.00 \+¥120\.00 已结算/ }))
    .toBeVisible();
});

test("没有收入预期时可手动结算上个周期", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "手动结算只需在桌面项目执行一次");
  await openLedger(page);

  const todayDay = await page.evaluate(() => new Date().getDate());
  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("500.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.getByRole("switch", { name: /打开发薪周期/ }).check();
  await settings.locator("#payday-day").fill(String(todayDay));
  await settings.locator("#default-savings-target").fill("100.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "10.00", note: "结算链路样本" });
  const summary = page.locator(".summary-panel");
  const settleButton = summary.getByRole("button", { name: "结算上个周期" });
  await expect(settleButton).toBeVisible();
  await settleButton.click();

  const settlementDialog = page.getByRole("dialog", { name: "结算上个周期" });
  await expect(settlementDialog.getByLabel("本次再留存")).toHaveValue("100.00");
  await settlementDialog.getByLabel("本次再留存").fill("60.00");
  await settlementDialog.getByLabel("备注（可选）").fill("手动周期结算");
  await settlementDialog.getByRole("button", { name: "完成结算" }).click();
  await expect(settlementDialog).toBeHidden();

  await expect(summary).toContainText("总余额¥490.00");
  await expect(summary).toContainText("已留存¥60.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥330.00");
  await expect(settleButton).toHaveCount(0);
  await expect(page.locator(".record-list li")).toHaveCount(1);
  await expect(page.getByText("结算链路样本", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "分析", exact: true }).click();
  const savingsDetailsToggle = page.locator('summary[aria-label="留存明细：查看记录"]');
  await savingsDetailsToggle.click();
  const savingsDetailsTable = page.locator("table").filter({
    has: page.locator("caption", { hasText: "留存明细" }),
  });
  await expect(savingsDetailsTable.getByRole("row", { name: /周期结算 \+¥60\.00 手动周期结算/ }))
    .toBeVisible();
});

test("默认取用方式会释放为可花资金且不生成账目", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "留存释放只需在桌面项目执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("300.00");
  await settings.getByRole("button", { name: "保存初始留存" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  const summary = page.locator(".summary-panel");
  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已留存¥300.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥700.00");
  await expect(page.getByText("账本还是空的", { exact: true })).toBeVisible();

  await summary.getByRole("button", { name: "取用留存" }).click();
  const releaseDialog = page.getByRole("dialog", { name: "取用留存" });
  await expect(releaseDialog.getByRole("button", { name: "释放为可花" }))
    .toHaveAttribute("aria-pressed", "true");
  await releaseDialog.getByLabel("金额").fill("50.00");
  await releaseDialog.getByLabel("备注（可选）").fill("临时释放");
  await releaseDialog.getByRole("button", { name: "确认取用" }).click();
  await expect(releaseDialog).toBeHidden();

  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已留存¥250.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥750.00");
  await expect(page.locator(".record-list li")).toHaveCount(0);
  await expect(page.getByText("账本还是空的", { exact: true })).toBeVisible();
});

test("留存、部分取用和关联支出删除撤销会联动更新", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整留存变更流只需在桌面项目执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("300.00");
  await settings.getByRole("button", { name: "保存初始留存" }).click();
  await settings.getByRole("switch", { name: /打开发薪周期/ }).check();
  await settings.locator("#payday-day").fill("28");
  await settings.locator("#default-savings-target").fill("100.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  const summary = page.locator(".summary-panel");
  await expect(summary.locator(".balance-value")).toHaveText("¥600.00");
  await expect(summary).toContainText("已留存¥300.00");
  await expect(summary).toContainText("尚需留存¥100.00");

  await summary.getByRole("button", { name: "留存一笔" }).click();
  const reserveDialog = page.getByRole("dialog", { name: "留存一笔" });
  await reserveDialog.getByLabel("金额").fill("50.00");
  await reserveDialog.getByLabel("备注（可选）").fill("本周期追加");
  await reserveDialog.getByRole("button", { name: "确认留存" }).click();
  await expect(reserveDialog).toBeHidden();
  await expect(summary).toContainText("已留存¥350.00");
  await expect(summary).toContainText("净增长¥50.00");
  await expect(summary).toContainText("尚需留存¥50.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥600.00");

  await summary.getByRole("button", { name: "取用留存" }).click();
  const releaseDialog = page.getByRole("dialog", { name: "取用留存" });
  await releaseDialog.getByRole("button", { name: "直接支出" }).click();
  await releaseDialog.getByLabel("支出总额").fill("200.00");
  await releaseDialog.getByLabel("其中使用留存").fill("100.00");
  await releaseDialog.getByLabel("支出说明").fill("临时设备");
  await releaseDialog.getByRole("button", { name: "记录支出" }).click();
  await expect(releaseDialog).toBeHidden();
  await expect(page.getByText("临时设备", { exact: true })).toBeVisible();
  await expect(summary).toContainText("总余额¥800.00");
  await expect(summary).toContainText("已留存¥250.00");
  await expect(summary.locator(".balance-value")).toHaveText("¥400.00");

  await page.getByRole("button", { name: "删除临时设备" }).click();
  await expect(page.locator(".record-list").getByText("临时设备", { exact: true })).toHaveCount(0);
  await expect(summary).toContainText("总余额¥1,000.00");
  await expect(summary).toContainText("已留存¥350.00");
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("临时设备", { exact: true })).toBeVisible();
  await expect(summary).toContainText("总余额¥800.00");
  await expect(summary).toContainText("已留存¥250.00");
});

test("支出穿透留存时预填实际缺口，账户转账不会误提示", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "穿透确认流只需在移动端执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("100.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("80.00");
  await settings.getByRole("button", { name: "保存初始留存" }).click();
  await settings.getByRole("switch", { name: /打开发薪周期/ }).check();
  await settings.locator("#payday-day").fill("28");
  await settings.locator("#default-savings-target").fill("0.00");
  await settings.getByRole("button", { name: "保存发薪周期" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "50.00", note: "动用测试" });
  const savingsPrompt = page.getByRole("dialog", { name: "确认动用留存" });
  await expect(savingsPrompt).toBeVisible();
  await expect(savingsPrompt.getByLabel("其中使用留存")).toHaveValue("30.00");
  await savingsPrompt.getByRole("button", { name: "确认取用" }).click();
  await expect(savingsPrompt).toBeHidden();
  await expect(page.locator(".summary-panel")).toContainText("已留存¥50.00");

  await page.getByRole("button", { name: "打开设置" }).click();
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("800.00");
  await settings.getByRole("button", { name: "保存初始留存" }).click();
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
