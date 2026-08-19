import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  dismissOfflineReady,
  expectNoHorizontalOverflow,
  openLedger,
  seedAnalysisLedger,
} from "./helpers";

test("页签支持哈希导航、刷新和返回", async ({ page }) => {
  await page.goto("./#unknown", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("link", { name: "记账", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.getByText("设置发薪日", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("设置后才能估算到账前后是否够花。")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("heading", { level: 2, name: "记一笔" })).toBeVisible();
});

test("稳定样本显示目标、单一收入和三张可访问图表", async ({ page }, testInfo) => {
  await openLedger(page);
  await seedAnalysisLedger(page, { includeCompletedCycleExpense: true });

  await expect(page.getByText("到下次", { exact: true })).toBeVisible();
  await expect(page.getByText("下次收入", { exact: true })).toBeVisible();
  await expect(page.locator(".summary-panel")).not.toContainText("最低收入");
  await expect(page.locator(".summary-panel")).not.toContainText("每期建议");

  if (testInfo.project.name === "mobile-chrome") {
    await expect(page.getByText("到下次", { exact: true })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "记一笔" })).toBeInViewport();
    const amountBounds = await page.getByLabel("金额").evaluate((input) => {
      const bounds = input.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight };
    });
    expect(amountBounds.top).toBeGreaterThanOrEqual(0);
    expect(amountBounds.bottom).toBeLessThanOrEqual(amountBounds.viewportHeight);
  }

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.locator(".analysis-confidence").getByText("近 30 天", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: /存钱目标/ })).toBeVisible();
  await expect(page.getByText("每期建议", { exact: true })).toBeVisible();
  await expect(page.getByText("下次收入", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("最低收入");
  await expect(page.locator("body")).not.toContainText("本周期留存");
  await expect(page.locator("body")).not.toContainText("尚需留存");
  await expect(page.locator("body")).not.toContainText("周期结算");

  const progress = page.getByRole("progressbar", { name: "存钱目标进度" });
  await expect(progress).toHaveAttribute("aria-valuetext", /已存.+目标/);
  await expect(progress).toHaveAttribute("max", "100000");

  await expect(page.locator(".analysis-chart-section")).toHaveCount(3);
  await expect(page.locator(".analysis-chart .recharts-wrapper")).toHaveCount(3);
  const chartSizes = await page.locator(".analysis-chart .recharts-wrapper").evaluateAll((charts) => charts.map((chart) => {
    const bounds = chart.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height };
  }));
  expect(chartSizes.every(({ width, height }) => width > 100 && height > 100)).toBe(true);

  const accessibleCharts = page.locator(".analysis-chart .recharts-surface[role='application']");
  await expect(accessibleCharts).toHaveCount(3);
  await expect(accessibleCharts.nth(0)).toHaveAccessibleName("当前周期支出");
  await expect(accessibleCharts.nth(0)).toHaveAccessibleDescription(/已支出/);
  await expect(accessibleCharts.nth(1)).toHaveAccessibleName("完整周期支出");
  await expect(accessibleCharts.nth(2)).toHaveAccessibleName("近 30 日支出");

  const renderedLines = await page.locator("#current-cycle-chart-title")
    .locator("xpath=ancestor::section")
    .locator(".recharts-line-curve")
    .evaluateAll((paths) => paths.map((path) => ({
      length: (path as SVGPathElement).getTotalLength(),
      height: (path as SVGPathElement).getBBox().height,
    })));
  expect(renderedLines.some(({ length }) => length > 20)).toBe(true);
  expect(renderedLines.some(({ height }) => height > 20)).toBe(true);

  for (const chartTitleId of ["completed-cycle-chart-title", "daily-expense-chart-title"]) {
    const bars = page.locator(`section[aria-labelledby="${chartTitleId}"] .recharts-bar-rectangle`);
    expect(await bars.count()).toBeGreaterThan(0);
    const sizes = await bars.evaluateAll((shapes) => shapes.map((shape) => {
      const bounds = (shape as SVGGraphicsElement).getBBox();
      return { width: bounds.width, height: bounds.height };
    }));
    expect(sizes.some(({ width, height }) => width > 1 && height > 1)).toBe(true);
  }

  const dailyRows = page.locator("#daily-expense-chart-title")
    .locator("xpath=ancestor::section")
    .locator("tbody tr");
  await expect(dailyRows).toHaveCount(30);
  await expect(dailyRows.filter({ hasText: "¥0.00" }).first()).toBeAttached();

  await expect(page.locator(".analysis-chart-key")).toHaveCount(3);
  await expect(page.locator("table caption")).toHaveText([
    "存钱明细",
    "当前周期累计支出",
    "完整到账周期支出",
    "每日支出",
  ]);
  const tableToggles = page.locator(".analysis-data-details summary");
  await expect(tableToggles).toHaveCount(4);
  await tableToggles.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(tableToggles.nth(1).locator("xpath=..//table")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("超长金额不造成横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "长金额边界执行一次");
  await openLedger(page);
  await seedAnalysisLedger(page, { initialBalanceMinor: 9_000_000_000_000_000 });
  await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
    .toContainText("89,999,999,999,939");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.locator(".analysis-metric dt").filter({ hasText: "总余额" })).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
});

test("分析代码预缓存后可离线重载", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "离线分析在移动端执行一次");
  await openLedger(page);
  await seedAnalysisLedger(page);
  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.locator(".analysis-chart-section")).toHaveCount(3);

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
    await dismissOfflineReady(page);
    await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
    await expect(page.locator(".analysis-chart-section")).toHaveCount(3);
  } finally {
    await context.setOffline(false);
  }
});
