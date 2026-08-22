import { expect, test } from "@playwright/test";

test("public product explains the private access boundary", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Build, reason and verify");
  await expect(page.getByRole("link", { name: /request access/i }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("request access form exposes the intended fields", async ({ page }) => {
  await page.goto("/request-access");
  await expect(page.getByLabel("Namn")).toBeVisible();
  await expect(page.getByLabel("E-post")).toBeVisible();
  await expect(page.getByRole("button", { name: "Skicka ansökan" })).toBeVisible();
});
