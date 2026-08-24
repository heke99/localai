import { expect, test } from "@playwright/test";

test("Vercel review pages are public", async ({ request }) => {
  const pages = [
    ["/docs/vercel-integration", "Vercel integration"],
    ["/legal/eula", "End User License Agreement"],
    ["/legal/privacy", "Privacy Policy"],
    ["/support", "DIV3RSA Support"]
  ] as const;
  for (const [path, text] of pages) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain(text);
  }
});
