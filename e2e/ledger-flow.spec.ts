import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  addTextEntry,
  dismissOfflineReady,
  ensureServiceWorkerControl,
  openLedger,
} from "./helpers";

test("初始余额锁定后通过审计调整，编辑和删除仍准确重算", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "完整变更流只需在桌面项目执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("100.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await expect(settings.getByText("初始余额已更新", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥100.00");

  await addTextEntry(page, { amount: "30.00", note: "午餐" });
  await addTextEntry(page, { amount: "12.00", note: "稿费", kind: "income" });
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥82.00");
  await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
    .toHaveText("¥82.00");

  await page.getByRole("button", { name: "打开设置" }).click();
  await expect(settings.locator("#initial-balance")).toHaveCount(0);
  await expect(settings.getByText("已有记录，起点已锁定", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "校准余额" }).click();

  const reconciliation = page.getByRole("dialog", { name: "校准余额" });
  await reconciliation.getByLabel("实际总额").fill("90.00");
  await reconciliation.getByLabel("说明").fill("核对现金");
  await reconciliation.getByRole("button", { name: "确认" }).click();
  await expect(reconciliation).toBeHidden();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥90.00");
  const reconciliationRow = page.getByRole("article").filter({ hasText: "余额校准" });
  await expect(reconciliationRow).toContainText("核对现金");
  await expect(reconciliationRow).toContainText("+¥8.00");

  const adjustmentUndo = page.locator(".adjustment-undo-toast");
  await expect(adjustmentUndo).toContainText("余额已校准");
  await adjustmentUndo.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥82.00");
  await expect(reconciliationRow).toContainText("已撤销");

  await page.getByRole("button", { name: "打开设置" }).click();
  await settings.getByRole("button", { name: "更正起点" }).click();
  const openingCorrection = page.getByRole("dialog", { name: "更正起点" });
  await openingCorrection.getByLabel("新起点").fill("120.00");
  await openingCorrection.getByLabel("说明").fill("录入时少算");
  await openingCorrection.getByRole("button", { name: "确认" }).click();
  await expect(openingCorrection).toBeHidden();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥102.00");
  const correctionRow = page.getByRole("article").filter({ hasText: "起点更正" });
  await expect(correctionRow).toContainText("录入时少算");
  await expect(correctionRow).toContainText("+¥20.00");

  await page.getByRole("button", { name: "编辑午餐" }).click();
  const editor = page.getByRole("dialog", { name: "编辑记录" });
  await editor.getByLabel("金额").fill("20.00");
  await editor.getByLabel("这笔是什么").fill("工作餐");
  await editor.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByText("工作餐", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥112.00");

  await page.getByRole("button", { name: "删除稿费" }).click();
  await expect(page.locator(".record-list").getByText("稿费", { exact: true })).toHaveCount(0);
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥100.00");
  await page.locator(".undo-toast").getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("稿费", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("¥112.00");
});

test("大额交易统一进入待处理，稍后操作在当天刷新后仍隐藏", async ({ page }, testInfo) => {
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
  const prompt = page.getByRole("dialog", { name: "这笔怎么算" });
  const totalBalance = page.locator(".summary-savings-grid div")
    .filter({ hasText: "总余额" })
    .locator("dd");
  await expect(prompt).toBeVisible();
  await expect(page.getByText("一次性设备", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel .balance-value")).toHaveText("-¥800.00");
  await expect(totalBalance).toHaveText("-¥800.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  const pendingStrip = page.locator(".pending-strip");
  await expect(pendingStrip).toContainText("待处理 1");
  await pendingStrip.getByRole("button", { name: "查看" }).click();
  const pendingDialog = page.getByRole("dialog", { name: "待处理" });
  await expect(pendingDialog.getByText("确认交易", { exact: true })).toBeVisible();
  await expect(pendingDialog).toContainText("一次性设备");
  await pendingDialog.getByRole("button", { name: "去确认" }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole("radio", { name: /仅这一次/ }).check();
  await prompt.getByRole("button", { name: "确认" }).click();
  await expect(prompt).toBeHidden();
  await expect(pendingStrip).toHaveCount(0);

  await addTextEntry(page, { amount: "800.00", note: "稍后设备" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "稍后处理" }).click();
  await expect(prompt).toBeHidden();
  await expect(pendingStrip).toHaveCount(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  await expect(pendingStrip).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: "稍后设备" }))
    .toContainText("支出 · 待确认");

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.getByRole("region", { name: "资金推导" })).toBeVisible();
  await expect(page.getByRole("region", { name: "估算依据" })).toContainText("待确认 1");
  await page.getByRole("link", { name: "记账" }).click();

  const record = page.getByRole("article").filter({ hasText: "一次性设备" });
  await expect(record).toContainText("支出 · 仅这一次");
  await expect(totalBalance).toHaveText("-¥1,600.00");

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: "一次性设备" }))
    .toContainText("支出 · 仅这一次");
  await expect(page.getByRole("article").filter({ hasText: "稍后设备" }))
    .toContainText("支出 · 待确认");
  await expect(pendingStrip).toHaveCount(0);
  await expect(totalBalance).toHaveText("-¥1,600.00");
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
    const goalDate = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate(), 12);
    return {
      todayDay: today.getDate(),
      todayDateKey: dateKey(today),
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

  await addTextEntry(page, { amount: "1.00", note: "启用资金摘要" });

  const summary = page.locator(".summary-panel");
  await expect(summary).toContainText(/到 \d{1,2}\/\d{1,2}/);
  await expect(summary).toContainText("下次收入");
  await expect(summary).toContainText("¥1,000.00");
  await expect(summary).not.toContainText("最低收入");
  await expect(summary).not.toContainText("每日可花");
  const pendingStrip = page.locator(".pending-strip");
  await expect(pendingStrip).toContainText("待处理 1");

  await page.getByRole("button", { name: "设置目标" }).click();
  const goalDialog = page.getByRole("dialog", { name: "存钱目标" });
  await goalDialog.getByLabel("目标额").fill("500.00");
  await goalDialog.getByLabel("截止日").fill(dates.goalDateKey);
  await goalDialog.getByRole("button", { name: "保存目标" }).click();
  await expect(goalDialog).toBeHidden();
  await expect(summary.getByRole("progressbar", { name: "存钱目标进度" }))
    .toHaveAttribute("aria-valuetext", "已存 ¥0.00，目标 ¥500.00");

  await pendingStrip.getByRole("button", { name: "查看" }).click();
  const pendingDialog = page.getByRole("dialog", { name: "待处理" });
  await expect(pendingDialog.getByText("确认到账", { exact: true })).toBeVisible();
  await pendingDialog.getByRole("button", { name: "去确认" }).click();
  const actualDialog = page.getByRole("dialog", { name: "实际收入" });
  await expect(actualDialog.getByLabel("实际额")).toHaveValue("1000.00");
  await expect(actualDialog.getByLabel("到账日")).toHaveValue(dates.todayDateKey);
  await expect(actualDialog.getByText("本次再留存")).toHaveCount(0);
  await actualDialog.getByRole("button", { name: "确认收入" }).click();
  await expect(actualDialog).toBeHidden();
  await expect(page.getByText("本次实际收入", { exact: true })).toBeVisible();
  await expect(summary.locator(".balance-value")).toHaveText("¥999.00");
  await expect(pendingStrip).toHaveCount(0);
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

test("支出穿透存款时预填实际缺口，详情不提供账户转账", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "穿透确认流只需在移动端执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.locator("#initial-savings").fill("850.00");
  await settings.getByRole("button", { name: "保存存款" }).click();
  await settings.getByRole("switch", { name: /启用发薪日/ }).check();
  await settings.locator("#payday-day").fill("28");
  await settings.getByRole("button", { name: "保存发薪日" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "190.00", note: "动用测试" });
  const savingsPrompt = page.getByRole("dialog", { name: "确认取用" });
  await expect(savingsPrompt).toBeVisible();
  await expect(savingsPrompt.getByLabel("使用存款")).toHaveValue("40.00");
  await savingsPrompt.getByRole("button", { name: "确认取用", exact: true }).click();
  await expect(savingsPrompt).toBeHidden();
  await expect(page.locator(".summary-panel")).toContainText("已存¥810.00");

  await page.getByRole("button", { name: "编辑动用测试" }).click();
  const editor = page.getByRole("dialog", { name: "编辑记录" });
  await expect(editor.getByLabel("分析处理方式").locator('option[value="account_transfer"]'))
    .toHaveCount(0);
  await expect(editor).not.toContainText("账户间转账");
  await editor.getByLabel("金额").fill("199.00");
  await editor.getByRole("button", { name: "保存修改" }).click();
  await expect(savingsPrompt).toBeVisible();
  await expect(savingsPrompt.getByLabel("使用存款")).toHaveValue("9.00");
  await savingsPrompt.getByRole("button", { name: "确认取用", exact: true }).click();
  await expect(savingsPrompt).toBeHidden();
  await expect(page.locator(".summary-panel")).toContainText("已存¥801.00");
});

test("退款可稍后从待处理原子关联多笔支出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "退款分摊流只需在桌面项目执行一次");
  await openLedger(page);

  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.locator("#initial-balance").fill("1000.00");
  await settings.getByRole("button", { name: "保存余额" }).click();
  await settings.getByRole("button", { name: "关闭设置" }).click();

  await addTextEntry(page, { amount: "300.00", note: "设备配件" });
  const expenseTreatment = page.getByRole("dialog", { name: "这笔怎么算" });
  await expenseTreatment.getByRole("radio", { name: /之后报销/ }).check();
  await expenseTreatment.getByRole("button", { name: "确认", exact: true }).click();
  await expect(expenseTreatment).toBeHidden();
  await addTextEntry(page, { amount: "250.00", note: "差旅支出" });
  await expenseTreatment.getByRole("radio", { name: /之后报销/ }).check();
  await expenseTreatment.getByRole("button", { name: "确认", exact: true }).click();
  await expect(expenseTreatment).toBeHidden();
  await addTextEntry(page, { amount: "500.00", note: "报销到账", kind: "income" });

  const treatment = page.getByRole("dialog", { name: "确认资金来源" });
  await expect(treatment).toBeVisible();
  await treatment.getByRole("radio", { name: /退款或报销/ }).check();
  await treatment.getByRole("button", { name: "确认", exact: true }).click();

  const allocation = page.getByRole("dialog", { name: "关联支出" });
  await expect(allocation).toContainText("设备配件");
  await expect(allocation).toContainText("差旅支出");
  const allocationGroup = allocation.getByRole("group", { name: "选择原支出" });
  await expect(allocationGroup).toBeFocused();
  await allocation.getByRole("button", { name: "返回" }).click();
  await expect(treatment.getByRole("radio", { name: /退款或报销/ })).toBeFocused();
  await treatment.getByRole("button", { name: "确认", exact: true }).click();
  await expect(allocationGroup).toBeFocused();
  await allocation.getByRole("button", { name: "稍后关联" }).click();
  await expect(allocation).toBeHidden();

  const pendingStrip = page.locator(".pending-strip");
  await expect(pendingStrip).toContainText("待处理 1");
  await pendingStrip.getByRole("button", { name: "查看" }).click();
  const pendingDialog = page.getByRole("dialog", { name: "待处理" });
  await expect(pendingDialog.getByText("关联支出", { exact: true })).toBeVisible();
  await expect(pendingDialog).toContainText("2 笔可选");
  await pendingDialog.getByRole("button", { name: "去关联" }).click();

  await expect(treatment).toBeVisible();
  await expect(treatment.getByRole("radio", { name: /退款或报销/ })).toBeChecked();
  await treatment.getByRole("button", { name: "确认", exact: true }).click();
  await expect(allocation).toBeVisible();
  await allocation.getByRole("checkbox", { name: /设备配件/ }).check();
  await allocation.getByRole("checkbox", { name: /差旅支出/ }).check();
  await allocation.getByLabel("设备配件的分摊金额").fill("275.00");
  await allocation.getByLabel("差旅支出的分摊金额").fill("225.00");
  await allocation.getByRole("button", { name: "关联", exact: true }).click();

  await expect(allocation).toBeHidden();
  await expect(pendingStrip).toHaveCount(0);
  await expect(page.getByRole("article").filter({ hasText: "报销到账" }))
    .toContainText("收入 · 退款报销");

  const deviceRecord = page.getByRole("article").filter({ hasText: "设备配件" });
  const travelRecord = page.getByRole("article").filter({ hasText: "差旅支出" });
  await expect(deviceRecord).toContainText("待报 ¥25.00");
  await expect(travelRecord).toContainText("待报 ¥25.00");

  await deviceRecord.getByRole("button", { name: "结束报销" }).click();
  const closeReimbursement = page.getByRole("dialog", { name: "结束报销" });
  await expect(closeReimbursement).toContainText("未报 ¥25.00");
  await closeReimbursement.getByRole("radio", { name: /按日常算/ }).check();
  await closeReimbursement.getByRole("button", { name: "确认结束" }).click();
  await expect(deviceRecord).toContainText("自付 ¥25.00");
  await expect(deviceRecord.getByRole("button", { name: "编辑设备配件" })).toBeFocused();

  await travelRecord.getByRole("button", { name: "结束报销" }).click();
  await closeReimbursement.getByRole("radio", { name: /周期账单/ }).check();
  await closeReimbursement.getByRole("button", { name: "确认结束" }).click();
  await expect(travelRecord).toContainText("周期账单 · 自付 ¥25.00");

  const persisted = await page.evaluate(async () => {
    interface StoredEntry {
      id: string;
      note?: string;
      treatment?: string;
      confirmationStatus?: string;
    }
    interface StoredAllocation {
      amountMinor: number;
      deletedAt?: string;
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("jiyibi");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const readAll = <T,>(storeName: string) => new Promise<T[]>((resolve, reject) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result as T[]);
    });
    const entries = await readAll<StoredEntry>("entries");
    const allocations = (await readAll<StoredAllocation>("recoveryAllocations"))
      .filter((item) => !item.deletedAt);
    database.close();
    const refund = entries.find((entry) => entry.note === "报销到账");
    const device = entries.find((entry) => entry.note === "设备配件");
    const travel = entries.find((entry) => entry.note === "差旅支出");
    return {
      treatment: refund?.treatment,
      confirmationStatus: refund?.confirmationStatus,
      closedTreatments: [device?.treatment, travel?.treatment],
      allocationAmounts: allocations.map((item) => item.amountMinor).sort((left, right) => left - right),
    };
  });
  expect(persisted).toEqual({
    treatment: "refund_reimbursement",
    confirmationStatus: "confirmed",
    closedTreatments: ["ordinary_expense", "periodic_expense"],
    allocationAmounts: [22_500, 27_500],
  });
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

  await ensureServiceWorkerControl(page);

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
    await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
      .toHaveText("-¥25.50");
  } finally {
    await context.setOffline(false);
  }
});
