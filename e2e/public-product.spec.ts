import { expect, test } from "@playwright/test";

test("public product explains the private access boundary", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Private AI");
  await expect(page.getByRole("link", { name: "Request Access" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign In" }).first()).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("request access form exposes the intended fields", async ({ page }) => {
  await page.goto("/request-access");
  await expect(page.getByRole("textbox", { name: /name/i })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /request/i })).toBeVisible();
});
