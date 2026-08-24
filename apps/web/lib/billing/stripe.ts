import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const stripeApiVersion = "2026-07-29.dahlia";
export const div3rsaMonthlyPriceId = process.env.STRIPE_PRICE_ID?.trim() || "price_1U7uhlDYqE0xrJ8noBNnu8Nl";

function integrationIdentifier() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(8);
  let suffix = "";
  for (const value of bytes) suffix += alphabet[value % alphabet.length];
  return `div3rsa_${suffix}`;
}

function setFormValue(form: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (typeof value === "boolean") form.set(key, value ? "true" : "false");
  else form.set(key, String(value));
}

type StripeObject = Record<string, unknown> & { id: string };

type CheckoutSession = StripeObject & {
  url?: string | null;
  customer?: string | null;
  subscription?: string | null;
  payment_status?: string | null;
};

type PortalSession = StripeObject & { url: string };

export class StripeClient {
  constructor(private readonly secretKey: string) {}

  static fromEnv() {
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (!secretKey) throw new Error("stripe_configuration_missing");
    return new StripeClient(secretKey);
  }

  private async request<T extends StripeObject>(method: "POST" | "DELETE", path: string, form?: URLSearchParams, idempotencyKey?: string): Promise<T> {
    const response = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        "Stripe-Version": stripeApiVersion,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
      },
      ...(method === "POST" ? { body: (form ?? new URLSearchParams()).toString() } : {}),
      cache: "no-store"
    });

    const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) {
      const code = body.error?.code || "stripe_request_failed";
      console.error("stripe_api_request_failed", { method, path, status: response.status, code });
      throw new Error(code);
    }
    return body;
  }

  private post<T extends StripeObject>(path: string, form: URLSearchParams, idempotencyKey?: string) {
    return this.request<T>("POST", path, form, idempotencyKey);
  }

  async createSubscriptionCheckout(input: {
    email: string;
    organizationId: string;
    accessRequestId?: string | null;
    appOrigin: string;
    idempotencyKey: string;
  }) {
    const form = new URLSearchParams();
    setFormValue(form, "mode", "subscription");
    setFormValue(form, "customer_email", input.email);
    setFormValue(form, "client_reference_id", input.organizationId);
    setFormValue(form, "line_items[0][price]", div3rsaMonthlyPriceId);
    setFormValue(form, "line_items[0][quantity]", 1);
    setFormValue(form, "success_url", `${input.appOrigin.replace(/\/$/, "")}/billing?checkout=success`);
    setFormValue(form, "cancel_url", `${input.appOrigin.replace(/\/$/, "")}/billing?checkout=canceled`);
    setFormValue(form, "metadata[organization_id]", input.organizationId);
    setFormValue(form, "subscription_data[metadata][organization_id]", input.organizationId);
    if (input.accessRequestId) {
      setFormValue(form, "metadata[access_request_id]", input.accessRequestId);
      setFormValue(form, "subscription_data[metadata][access_request_id]", input.accessRequestId);
    }
    setFormValue(form, "integration_identifier", integrationIdentifier());

    const session = await this.post<CheckoutSession>("/v1/checkout/sessions", form, input.idempotencyKey);
    if (!session.url) throw new Error("stripe_checkout_url_missing");
    return session;
  }

  async createCustomerPortal(customerId: string, returnUrl: string) {
    const form = new URLSearchParams();
    setFormValue(form, "customer", customerId);
    setFormValue(form, "return_url", returnUrl);
    const session = await this.post<PortalSession>("/v1/billing_portal/sessions", form);
    if (!session.url) throw new Error("stripe_portal_url_missing");
    return session;
  }

  async cancelSubscription(subscriptionId: string) {
    return this.request<StripeObject>("DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }
}

export function verifyStripeWebhook(payload: string, signatureHeader: string | null) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("stripe_webhook_configuration_missing");
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !signatures.length || !/^\d+$/.test(timestamp)) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((signature) => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
  });
}
