# DIV3RSA Stripe billing

## Commercial plan

- Product: `DIV3RSA`
- Monthly price: `2 000 SEK`
- Stripe product: `prod_V8B30EEyX0Racg`
- Stripe price: `price_1U7uhlDYqE0xrJ8noBNnu8Nl`
- Billing model: Stripe Billing + hosted Checkout, recurring monthly
- Normal paid access starts only after Stripe confirms the initial payment.

## Access modes

Each customer organization has exactly one platform access mode:

- `paid` — Stripe subscription required. `active`/`trialing` provider state grants agent access. `past_due`, `paused`, `canceled` and `inactive` do not.
- `free` — explicitly granted by superadmin and does not require Stripe.
- `trial` — explicitly granted by superadmin with a start/end time and token budget. Both time and remaining token budget are enforced by the database run gate.
- Superadmin is billing-exempt. Billing does not block a superadmin run.

Account lifecycle pause is separate from billing. Security/administrative account pause can still block an account independently of subscription state.

## Approval flow

When a superadmin approves an application they select Paid, Free or Trial.

Paid:
1. Provision user, organization and workspace.
2. Set organization access to `paid/inactive`.
3. Create a Stripe Checkout Session for the fixed monthly Price.
4. Store the Checkout Session and URL.
5. User can finish account onboarding, but agent access remains locked.
6. `checkout.session.completed` / paid subscription events change provider-confirmed state to `active`.
7. Dashboard and `start_agent_run` open automatically.

Free:
1. Provision normally.
2. Set access to `free/active`.
3. No Stripe customer or subscription is required.

Trial:
1. Provision normally.
2. Set access to `trial/trialing`.
3. Persist trial start/end and token limit.
4. Token usage is calculated from `internal.usage_events` input + output tokens for the user during the trial.
5. Agent runs are rejected when the end time is reached or the budget is exhausted.

## Webhook

Production endpoint:

`https://system.div3rsa.com/api/stripe/webhook`

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

- `STRIPE_SECRET_KEY` — use a Stripe restricted API key where possible; never expose as `NEXT_PUBLIC_*`.
- `STRIPE_WEBHOOK_SECRET` — signing secret for the production webhook endpoint.
- `STRIPE_PRICE_ID=price_1U7uhlDYqE0xrJ8noBNnu8Nl`

Checkout requires permission to create Checkout Sessions and read/write the associated Billing objects. Customer Portal requires permission to create portal sessions. Superadmin conversion from a live Paid subscription to Free/Trial requires subscription cancellation permission so charging stops before internal access is changed.

## Stripe Dashboard settings

- Configure the Customer Portal for payment-method management and cancellation policy.
- Enable Stripe Billing revenue-recovery settings such as Smart Retries and failed-payment emails according to the desired dunning policy.
- Do not implement a manual monthly charge loop in DIV3RSA; Stripe Billing owns renewals and retries.

## Tax

Stripe Tax is intentionally not enabled by application code. Before collecting VAT/sales tax automatically, confirm the company's relevant tax registrations in Stripe. Enabling automatic tax without active registrations can produce misleading expectations about tax collection.
