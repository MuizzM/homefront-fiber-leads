import { test, expect } from "@playwright/test";
import { loginAs, mintSession } from "./helpers/auth";

test("mobile More sheet and global field status are thumb-friendly and recoverable", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { sessionId } = await mintSession(request);
  await loginAs(page, sessionId);
  await page.goto("/#/today");

  await expect(page.getByTestId("bottom-tabs")).toBeVisible();
  const more = page.getByTestId("tab-more");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const sheet = page.getByRole("dialog", { name: "More navigation" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Leaderboard" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Commissions & Pay" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /Switch to .* mode/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();
  await expect(more).toBeFocused();

  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(page.getByTestId("field-status")).toContainText("Offline");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.getByTestId("field-status")).not.toBeVisible();
});
