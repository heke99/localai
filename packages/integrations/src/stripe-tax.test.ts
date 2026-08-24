import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeClient } from "../../../apps/web/lib/billing/stripe";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DIV3RSA Stripe subscription checkout", () => {
  it("enables automatic tax and tax ID collection without manual tax rates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "cs_test_div3rsa",
      url: "https://checkout.stripe.test/session"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    const stripe = new StripeClient("sk_test_mock");
    await stripe.createSubscriptionCheckout({
      email: "buyer@example.com",
      organizationId: "00000000-0000-0000-0000-000000000001",
      appOrigin: "https://system.div3rsa.com",
      idempotencyKey: "checkout-test"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(String(init?.body ?? ""));

    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price]")).toBe("price_1U7uhlDYqE0xrJ8noBNnu8Nl");
    expect(body.get("automatic_tax[enabled]")).toBe("true");
    expect(body.get("tax_id_collection[enabled]")).toBe("true");
    expect(body.has("payment_method_types[0]")).toBe(false);
    expect([...body.keys()].some((key) => key.includes("tax_rates"))).toBe(false);
  });
});
