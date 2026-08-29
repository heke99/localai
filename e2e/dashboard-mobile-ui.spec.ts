import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 320, height: 720 } });

test("mobile dashboard keeps chat history reachable without covering the composer", async ({ page }) => {
  await page.route("**/api/runtime/prewarm", (route) => route.fulfill({ status: 204 }));
  await page.goto("/e2e-dashboard-ui");

  const composer = page.getByPlaceholder("Vad vill du få gjort?");
  await expect(composer).toBeVisible();

  const historyToggle = page.getByRole("button", { name: "Öppna chatthistorik" });
  await expect(historyToggle).toBeVisible();
  await historyToggle.click();
  await expect(page.getByRole("button", { name: "Stäng chatthistorik" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Starta en fristående chatt" })).toBeVisible();

  await page.getByRole("button", { name: "Stäng chatthistorik" }).click();
  await expect(composer).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);

  const nav = page.getByRole("navigation", { name: "Huvudnavigation" });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inställningar" })).toBeAttached();
});
