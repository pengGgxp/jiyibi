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
  if (options.kind === "income") {
    await page.getByRole("radio", { name: "收入", exact: true }).click();
  }
  const amountInput = page.getByLabel("金额");
  const noteInput = page.getByLabel("这笔是什么");
  const saveButton = page.locator(".save-entry-button");
  await amountInput.fill(options.amount);
  await noteInput.fill(options.note);
  await saveButton.click();
  await expect(amountInput).toHaveValue("");
  await expect(noteInput).toHaveValue("");
  await expect(saveButton).toBeEnabled();
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

export async function seedAnalysisLedger(
  page: Page,
  options: { completedDays?: number; initialBalanceMinor?: number } = {},
): Promise<void> {
  const completedDays = options.completedDays ?? 30;
  const initialBalanceMinor = options.initialBalanceMinor ?? 1_000_000;
  await page.evaluate(async ({ dayCount, balanceMinor }) => {
    const dateKey = (date: Date) => [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    const today = new Date();
    const nextPayday = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
      12,
    );
    const targetPaydayDateKey = dateKey(nextPayday);
    const updatedAt = today.toISOString();
    const entries = [dayCount, Math.max(1, Math.ceil(dayCount / 2)), 1].map((daysAgo, index) => {
      const localDate = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate() - daysAgo,
        12,
      );
      const key = dateKey(localDate);
      return {
        id: `analysis-entry-${index}`,
        amountMinor: -(index + 1) * 1_000,
        note: `分析样本 ${index + 1}`,
        occurredAt: localDate.toISOString(),
        localDateKey: key,
        localMonthKey: key.slice(0, 7),
        timezoneOffsetMinutes: localDate.getTimezoneOffset(),
        createdAt: localDate.toISOString(),
        updatedAt: localDate.toISOString(),
      };
    });
    const observationDate = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - 220,
      12,
    );
    const observationKey = dateKey(observationDate);
    entries.unshift({
      id: "analysis-observation-start",
      amountMinor: 1,
      note: "分析观察起点",
      occurredAt: observationDate.toISOString(),
      localDateKey: observationKey,
      localMonthKey: observationKey.slice(0, 7),
      timezoneOffsetMinutes: observationDate.getTimezoneOffset(),
      createdAt: observationDate.toISOString(),
      updatedAt: observationDate.toISOString(),
    });

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("jiyibi");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(["entries", "settings"], "readwrite");
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        const entryStore = transaction.objectStore("entries");
        entryStore.clear();
        for (const entry of entries) entryStore.put(entry);
        transaction.objectStore("settings").put({
          id: "primary",
          currency: "CNY",
          initialBalanceMinor: balanceMinor,
          payCycle: {
            paydayDay: nextPayday.getDate(),
            cycleEndBalanceGoalMinor: 100_000,
          },
          incomeForecast: {
            id: "analysis-income-forecast",
            targetPaydayDateKey,
            minimumIncomeMinor: 10_000,
            expectedIncomeMinor: 20_000,
          },
          schemaVersion: 1,
          updatedAt,
        });
      };
    });
  }, { dayCount: completedDays, balanceMinor: initialBalanceMinor });
  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissOfflineReady(page);
}
