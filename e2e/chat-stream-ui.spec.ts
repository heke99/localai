import { expect, test } from "@playwright/test";

const runId = "11111111-1111-1111-1111-111111111111";
const conversationId = "22222222-2222-2222-2222-222222222222";

async function mockCompletedStream(page: Parameters<typeof test>[0] extends never ? never : any) {
  await page.route(`**/api/runs/${runId}/stream`, async (route: any) => {
    const snapshot = {
      runId,
      conversationId,
      status: "completed",
      content: "The current time in Europe/Stockholm is 00:09:00.",
      revision: 1,
      updatedAt: "2026-08-28T00:09:00+02:00"
    };
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform"
      },
      body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\nevent: done\ndata: ${JSON.stringify({ runId, conversationId, status: "completed" })}\n\n`
    });
  });
}

test("streamed assistant text becomes visible, follows the active chat and survives terminal transition", async ({ page }) => {
  await mockCompletedStream(page);
  await page.goto("/e2e-chat-stream");

  const answer = page.getByText("The current time in Europe/Stockholm is 00:09:00.");
  await expect(answer).toBeVisible();
  const stream = page.locator(`[data-run-stream="${runId}"]`);
  await expect(stream).toHaveAttribute("data-stream-revision", "1");
  await expect(stream).toHaveAttribute("role", "status");
  await expect(stream).toHaveAttribute("aria-live", "polite");

  await expect.poll(async () => page.getByTestId("chat-canvas").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Mark terminal" }).click();
  await expect(answer).toBeVisible();

  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(answer).toBeHidden();
});
