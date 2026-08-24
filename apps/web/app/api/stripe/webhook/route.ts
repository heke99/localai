import { NextResponse } from "next/server";
import { StripeClient, verifyStripeWebhook } from "../../../../lib/billing/stripe";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";

type StripeEvent = { id: string; type: string; created?: number; data?: { object?: Record<string, unknown> } };
type SubscriptionRow = { id: string; organization_id: string; access_mode: string; provider_subscription_id: string | null; provider_customer_id: string | null };

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function unixDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}
function subscriptionIdFromInvoice(invoice: Record<string, unknown>) {
  const direct = stringValue(invoice.subscription);
  if (direct) return direct;
  const parent = objectValue(invoice.parent);
  const details = parent ? objectValue(parent.subscription_details) : null;
  const nested = details ? stringValue(details.subscription) : null;
  if (nested) return nested;
  const lines = objectValue(invoice.lines);
  const data = Array.isArray(lines?.data) ? lines.data : [];
  for (const item of data) {
    const line = objectValue(item);
    const lineParent = line ? objectValue(line.parent) : null;
    const subItem = lineParent ? objectValue(lineParent.subscription_item_details) : null;
    const id = subItem ? stringValue(subItem.subscription) : null;
    if (id) return id;
  }
  return null;
}
function mapSubscriptionStatus(status: string | null) {
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "paused") return "paused";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return "inactive";
}

async function findSubscription(input: { organizationId?: string | null; subscriptionId?: string | null; customerId?: string | null }) {
  const admin = createSupabaseAdminClient();
  let query = admin.from("organization_subscriptions").select("id,organization_id,access_mode,provider_subscription_id,provider_customer_id").eq("access_mode", "paid");
  if (input.organizationId) query = query.eq("organization_id", input.organizationId);
  else if (input.subscriptionId) query = query.eq("provider_subscription_id", input.subscriptionId);
  else if (input.customerId) query = query.eq("provider_customer_id", input.customerId);
  else return null;
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data as SubscriptionRow | null;
}

async function applyProviderStatus(row: SubscriptionRow, event: StripeEvent, providerStatus: string | null, effectiveAt?: string | null, currentPeriodEnd?: string | null, customerId?: string | null, subscriptionId?: string | null) {
  const admin = createSupabaseAdminClient();
  const status = mapSubscriptionStatus(providerStatus);
  const eventAt = event.created ? new Date(event.created * 1000).toISOString() : new Date().toISOString();

  if (status === "inactive") {
    const { error } = await admin.from("organization_subscriptions").update({
      status: "inactive",
      provider_status: providerStatus,
      last_provider_event_id: event.id,
      last_provider_event_at: eventAt,
      last_error_code: providerStatus === "incomplete" ? "payment_incomplete" : null,
      provider_customer_id: customerId ?? row.provider_customer_id,
      provider_subscription_id: subscriptionId ?? row.provider_subscription_id,
      current_period_end: currentPeriodEnd,
      updated_at: new Date().toISOString()
    }).eq("id", row.id).eq("access_mode", "paid");
    if (error) throw new Error(error.message);
    return;
  }

  const { error: rpcError } = await admin.rpc("service_confirm_subscription_status", {
    target_subscription_id: row.id,
    target_status: status,
    target_provider_status: providerStatus,
    target_effective_at: effectiveAt ?? null,
    target_provider_event_id: event.id,
    target_provider_event_at: eventAt,
    target_error_code: status === "past_due" ? "payment_failed" : null
  });
  if (rpcError) throw new Error(rpcError.message);

  const { error: updateError } = await admin.from("organization_subscriptions").update({
    provider_customer_id: customerId ?? row.provider_customer_id,
    provider_subscription_id: subscriptionId ?? row.provider_subscription_id,
    current_period_end: currentPeriodEnd,
    checkout_url: status === "active" || status === "trialing" ? null : undefined,
    updated_at: new Date().toISOString()
  }).eq("id", row.id).eq("access_mode", "paid");
  if (updateError) throw new Error(updateError.message);
}

async function handleCheckoutCompleted(event: StripeEvent, session: Record<string, unknown>) {
  const metadata = objectValue(session.metadata);
  const organizationId = metadata ? stringValue(metadata.organization_id) : stringValue(session.client_reference_id);
  const subscriptionId = stringValue(session.subscription);
  const customerId = stringValue(session.customer);
  if (!organizationId) return;
  const row = await findSubscription({ organizationId });
  if (!row) return;

  const paymentStatus = stringValue(session.payment_status);
  const providerStatus = paymentStatus === "paid" || paymentStatus === "no_payment_required" ? "active" : "incomplete";
  await applyProviderStatus(row, event, providerStatus, null, null, customerId, subscriptionId);

  const admin = createSupabaseAdminClient();
  const accessRequestId = metadata ? stringValue(metadata.access_request_id) : null;
  if (accessRequestId) {
    await admin.from("access_requests").update({ billing_checkout_url: null }).eq("id", accessRequestId);
  }
}

async function handleSubscription(event: StripeEvent, subscription: Record<string, unknown>) {
  const metadata = objectValue(subscription.metadata);
  const organizationId = metadata ? stringValue(metadata.organization_id) : null;
  const subscriptionId = stringValue(subscription.id);
  const customerId = stringValue(subscription.customer);
  const row = await findSubscription({ organizationId, subscriptionId, customerId });
  if (!row) return;
  const status = event.type === "customer.subscription.deleted" ? "canceled" : stringValue(subscription.status);
  await applyProviderStatus(row, event, status, status === "paused" ? new Date().toISOString() : null, unixDate(subscription.current_period_end), customerId, subscriptionId);
}

async function handleInvoice(event: StripeEvent, invoice: Record<string, unknown>) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const customerId = stringValue(invoice.customer);
  const row = await findSubscription({ subscriptionId, customerId });
  if (!row) return;
  const providerStatus = event.type === "invoice.paid" ? "active" : "past_due";
  await applyProviderStatus(row, event, providerStatus, null, null, customerId, subscriptionId);
}

export async function POST(request: Request) {
  const payload = await request.text();
  if (!verifyStripeWebhook(payload, request.headers.get("stripe-signature"))) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try { event = JSON.parse(payload) as StripeEvent; }
  catch { return NextResponse.json({ error: "invalid_payload" }, { status: 400 }); }

  const object = objectValue(event.data?.object);
  try {
    if (object && event.type === "checkout.session.completed") await handleCheckoutCompleted(event, object);
    else if (object && event.type.startsWith("customer.subscription.")) await handleSubscription(event, object);
    else if (object && (event.type === "invoice.paid" || event.type === "invoice.payment_failed")) await handleInvoice(event, object);
  } catch (error) {
    const code = error instanceof Error ? error.message : "stripe_webhook_sync_failed";
    console.error("stripe_webhook_sync_failed", { eventId: event.id, eventType: event.type, code });
    return NextResponse.json({ error: "sync_failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
