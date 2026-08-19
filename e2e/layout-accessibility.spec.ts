import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { addTextEntry, expectNoHorizontalOverflow, openLedger } from "./helpers";

test("核心记账布局在当前视口可用且无障碍", async ({ page }, testInfo) => {
  await openLedger(page);

  if (testInfo.project.name === "mobile-chrome") {
    await expect(page.locator(".summary-panel .balance-value")).toBeInViewport();
    await expect(page.getByRole("heading", { level: 2, name: "记一笔" })).toBeInViewport();
  }

  const longNote = "一笔用于验证手机平板桌面长文本换行的账目说明".repeat(8).slice(0, 200);
  await addTextEntry(page, { amount: "25.80", note: longNote });

  await expect(page.locator(".summary-panel .balance-value")).toHaveText("-¥25.80");
  await expect(page.locator(".summary-savings-grid div").filter({ hasText: "总余额" }).locator("dd"))
    .toHaveText("-¥25.80");
  await expect(page.getByText(longNote, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const layout = await page.locator(".workspace-grid").evaluate((grid) => {
    const composer = grid.querySelector<HTMLElement>(".composer-panel")!.getBoundingClientRect();
    const summary = grid.querySelector<HTMLElement>(".summary-panel")!.getBoundingClientRect();
    return {
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      composerTop: composer.top,
      summaryTop: summary.top,
      composerRight: composer.right,
      summaryLeft: summary.left,
    };
  });

  if (testInfo.project.name === "mobile-chrome") {
    expect(layout.columns).toBe(1);
    expect(layout.summaryTop).toBeLessThan(layout.composerTop);
  } else {
    expect(layout.columns).toBe(2);
    expect(Math.abs(layout.summaryTop - layout.composerTop)).toBeLessThanOrEqual(1);
    expect(layout.summaryLeft).toBeGreaterThan(layout.composerRight);
  }

  const tooSmallTargets = await page.locator("button:visible, summary:visible, .primary-navigation-link:visible").evaluateAll((targets) =>
    targets
      .map((target) => {
        const rect = target.getBoundingClientRect();
        return { label: target.getAttribute("aria-label") ?? target.textContent?.trim(), width: rect.width, height: rect.height };
      })
      .filter(({ width, height }) => width < 44 || height < 44),
  );
  expect(tooSmallTargets).toEqual([]);

  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
