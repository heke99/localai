# DIV3RSA Stripe billing

## Commercial plan

- Product: `DIV3RSA`
- Monthly price: `2 000 SEK` excluding VAT
- Stripe product: `prod_V8B30EEyX0Racg`
- Stripe price: `price_1U7uhlDYqE0xrJ8noBNnu8Nl`
- Price tax behavior: `exclusive`
- Billing model: Stripe Billing + hosted Checkout, recurring monthly
- Normal paid access starts only after Stripe confirms the initial payment.

## Access modes

Each customer organization has exactly one platform access mode:

- `paid` — Stripe subscription required. `active`/`trialing` provider state grants agent access. `past_due`, `paused`, `canceled` and `inactive` do not.
- `free` — explicitly granted by superadmin and does not require Stripe.
- `trial` — explicitly granted by superadmin with a start/end time and organization-wide token budget. Both time and remaining token budget are enforced by the database run gate.
- Superadmin is billing-exempt. Billing does not block a superadmin run.

Account lifecycle pause is separate from billing. Security/administrative account pause can still block an account independently of subscription state.

## Approval flow

When a superadmin approves an application they select Paid, Free or Trial.

Paid:
1. Provision user, organization and workspace.
2. Set organization access to `paid/inactive`.
3. Create a Stripe Checkout Session for the fixed monthly Price.
4. Enable Stripe Tax automatically and collect VAT/tax IDs in Checkout.
5. Store the Checkout Session and URL.
6. User can finish account onboarding, but agent access remains locked.
7. `checkout.session.completed` / paid subscription events change provider-confirmed state to `active`.
8. Dashboard and `start_agent_run` open automatically.

Free:
1. Provision normally.
2. Set access to `free/active`.
3. No Stripe customer or subscription is required.

Trial:
1. Provision normally.
2. Set access to `trial/trialing`.
3. Persist trial start/end and token limit.
4. Token usage is calculated from `internal.usage_events` input + output tokens across the organization during the trial.
5. Agent runs are rejected when the end time is reached or the organization-wide budget is exhausted.

## Webhook

Production endpoint:

`https://system.div3rsa.com/api/stripe/webhook`

Stripe live webhook endpoint:

`we_1U7v5ADYqE0xrJ8nv6WgIabh`

Subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The endpoint verifies `Stripe-Signature`, maps the Stripe lifecycle into `organization_subscriptions`, and only mutates rows whose `access_mode` is `paid`. Old Stripe events cannot overwrite Free or Trial access.

Failed renewal moves Paid access to `past_due` and the database immediately rejects new agent runs. A later `invoice.paid` moves it back to `active` and access resumes automatically.

## Required server configuration

Set these only as server-side Vercel environment variables:

- `STRIPE_SECRET_KEY` — preferably a restricted Stripe API key with only the required Checkout/Billing/Customer Portal permissions; never expose as `NEXT_PUBLIC_*`.
- `STRIPE_WEBHOOK_SECRET` — signing secret for webhook endpoint `we_1U7v5ADYqE0xrJ8nv6WgIabh`.
- `STRIPE_PRICE_ID=price_1U7uhlDYqE0xrJ8noBNnu8Nl`

Checkout requires permission to create Checkout Sessions and read/write the associated Billing objects. Customer Portal requires permission to create portal sessions. Superadmin conversion from a live Paid subscription to Free/Trial requires subscription cancellation permission so charging stops before internal access is changed.

## Stripe Dashboard settings

- Configure the Customer Portal for payment-method management and cancellation policy.
- Enable Stripe Billing revenue-recovery settings such as Smart Retries and failed-payment emails according to the desired dunning policy.
- Do not implement a manual monthly charge loop in DIV3RSA; Stripe Billing owns renewals and retries.

## Tax

Production Stripe Tax is enabled for Paid Checkout Sessions.

- Head office: Malmö, Sweden.
- Swedish Tax Registration: `taxreg_1U7v8dDYqE0xrJ8nklYZPZ8y`, status `active`.
- Registration type: Sweden / standard VAT.
- Monthly price tax behavior: `exclusive` — 2 000 SEK is before VAT.
- Checkout uses `automatic_tax[enabled]=true`.
- Checkout uses `tax_id_collection[enabled]=true` so eligible B2B customers can provide VAT/tax IDs.
- Stripe determines applicable VAT/tax from the customer's location, tax ID and active tax registrations; DIV3RSA does not hard-code a 25% rate.
- Stripe Tax calculates and collects tax but does not replace VAT reporting/filing obligations.
