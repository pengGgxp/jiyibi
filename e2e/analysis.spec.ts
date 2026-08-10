import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  dismissOfflineReady,
  expectNoHorizontalOverflow,
  openLedger,
  seedAnalysisLedger,
} from "./helpers";

test("页签使用哈希导航并支持刷新、返回和未知地址回退", async ({ page }) => {
  await page.goto("./#unknown", { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("link", { name: "记账", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page).toHaveURL(/#analysis$/);
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.getByText("先设置工资周期")).toBeVisible();
  await expect(page.getByRole("link", { name: "分析", exact: true })).toHaveAttribute("aria-current", "page");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 2, name: "够不够花" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#ledger$/);
  await expect(page.getByRole("heading", { level: 2, name: "记一笔" })).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
});

test("稳定样本会生成三张可访问图表和完整数据表", async ({ page }, testInfo) => {
  await openLedger(page);
  await seedAnalysisLedger(page);

  if (testInfo.project.name === "mobile-chrome") {
    await expect(page.getByText("到发薪日", { exact: true })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "记一笔" })).toBeInViewport();
  }

  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.getByText("按近 30 天估算", { exact: true })).toBeVisible();
  await expect(page.getByText("预计够用", { exact: true })).toBeVisible();
  await expect(page.getByText("工资预计够用", { exact: true })).toBeVisible();
  await expect(page.locator(".analysis-chart-section")).toHaveCount(3);
  await expect(page.locator(".analysis-chart .recharts-wrapper")).toHaveCount(3);
  const accessibleCharts = page.locator(".analysis-chart .recharts-surface[role='application']");
  await expect(accessibleCharts).toHaveCount(3);
  await expect(accessibleCharts.nth(0)).toHaveAttribute("aria-labelledby", "current-cycle-chart-title");
  await expect(accessibleCharts.nth(1)).toHaveAttribute("aria-labelledby", "completed-cycle-chart-title");
  await expect(accessibleCharts.nth(2)).toHaveAttribute("aria-labelledby", "daily-expense-chart-title");
  await expect(page.locator(".recharts-reference-line-line")).toHaveCount(2);
  await expect(page.locator("#daily-expense-chart-title")).toContainText("近三十天");
  const renderedLines = await page.locator("#current-cycle-chart-title")
    .locator("xpath=ancestor::section")
    .locator(".recharts-line-curve")
    .evaluateAll((paths) => paths.map((path) => ({
      length: (path as SVGPathElement).getTotalLength(),
      height: (path as SVGPathElement).getBBox().height,
    })));
  expect(renderedLines.some(({ length }) => length > 20)).toBe(true);
  expect(renderedLines.some(({ height }) => height > 20)).toBe(true);

  const dailyRows = page.locator("#daily-expense-chart-title")
    .locator("xpath=ancestor::section")
    .locator("tbody tr");
  await expect(dailyRows).toHaveCount(30);
  await expect(dailyRows.filter({ hasText: "¥0.00" }).first()).toBeAttached();

  const firstTableToggle = page.locator(".analysis-data-details summary").first();
  await firstTableToggle.focus();
  await page.keyboard.press("Enter");
  await expect(firstTableToggle.locator("xpath=..//table")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test("超长金额不会挤出首页或分析页", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "长金额边界只需在桌面项目执行一次");
  await openLedger(page);
  await seedAnalysisLedger(page, { initialBalanceMinor: 9_000_000_000_000_000 });

  await expect(page.locator(".summary-panel .balance-value")).toContainText("89,999,999,999,940");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("link", { name: "分析", exact: true }).click();
  await expect(page.getByText("预计周期末余额")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("分析代码预缓存后可离线重载", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chrome", "离线分析只需在移动端 Chromium 执行一次");
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
