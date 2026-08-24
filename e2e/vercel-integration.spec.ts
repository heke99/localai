import { expect, test } from "@playwright/test";

test("Vercel connect route requires an authenticated workspace session", async ({ request }) => {
  const workspaceId = "00000000-0000-4000-8000-000000000000";
  const response = await request.get(
    `/api/integrations/vercel/connect?workspaceId=${workspaceId}&returnPath=${encodeURIComponent("/dashboard?section=integrations")}`,
    { maxRedirects: 0 }
  );

  expect(response.status()).toBe(303);
  expect(response.headers().location).toContain("/sign-in");
});

test("Vercel Integration Console webhook route is deployed and POST-only", async ({ request }) => {
  const response = await request.get("/api/integrations/vercel/webhook", { maxRedirects: 0 });
  expect(response.status()).toBe(405);
});

test("Vercel review URLs are public and complete", async ({ request }) => {
  const pages = [
    ["/docs/vercel-integration", "Vercel integration"],
    ["/legal/eula", "End User License Agreement"],
    ["/legal/privacy", "Privacy Policy"],
    ["/support", "DIV3RSA Support"]
  ] as const;

  for (const [path, expectedText] of pages) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain(expectedText);
  }
});
