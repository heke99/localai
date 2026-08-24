import { NextResponse } from "next/server";
import { verifyStripeWebhook } from "../../../../lib/billing/stripe";
import {
  mapStripeSubscriptionStatus,
  reconcileRenewalConfirmation,
  resolveLocalSubscriptionStatus,
  shouldApplyPaidInvoiceAsActive,
  type RenewalAction,
  type TerminationIntent
} from "../../../../lib/billing/subscription-state";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";

type StripeEvent = { id: string; type: string; created?: number; data?: { object?: Record<string, unknown> } };
type SubscriptionRow = {
  id: string;
  organization_id: string;
  access_mode: string;
  status: string;
  requested_action: string | null;
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  termination_intent: string | null;
  renewal_action_requested: string | null;
};

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

async function findSubscription(input: { organizationId?: string | null; subscriptionId?: string | null; customerId?: string | null }) {
  const admin = createSupabaseAdminClient();
  let query = admin.from("organization_subscriptions").select("id,organization_id,access_mode,status,requested_action,provider_subscription_id,provider_customer_id,termination_intent,renewal_action_requested").eq("access_mode", "paid");
  if (input.organizationId) query = query.eq("organization_id", input.organizationId);
  else if (input.subscriptionId) query = query.eq("provider_subscription_id", input.subscriptionId);
  else if (input.customerId) query = query.eq("provider_customer_id", input.customerId);
  else return null;
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data as SubscriptionRow | null;
}

async function applyProviderStatus(
  row: SubscriptionRow,
  event: StripeEvent,
  providerStatus: string | null,
  options?: {
    localStatus?: ReturnType<typeof mapStripeSubscriptionStatus>;
    effectiveAt?: string | null;
    currentPeriodEnd?: string | null;
    customerId?: string | null;
    subscriptionId?: string | null;
  }
) {
  const admin = createSupabaseAdminClient();
  const status = options?.localStatus ?? mapStripeSubscriptionStatus(providerStatus);
  const eventAt = event.created ? new Date(event.created * 1000).toISOString() : new Date().toISOString();

  if (status === "inactive") {
    const { error } = await admin.from("organization_subscriptions").update({
      status: "inactive",
      provider_status: providerStatus,
      last_provider_event_id: event.id,
      last_provider_event_at: eventAt,
      last_error_code: providerStatus === "incomplete" ? "payment_incomplete" : null,
      provider_customer_id: options?.customerId ?? row.provider_customer_id,
      provider_subscription_id: options?.subscriptionId ?? row.provider_subscription_id,
      current_period_end: options?.currentPeriodEnd ?? null,
      updated_at: new Date().toISOString()
    }).eq("id", row.id).eq("access_mode", "paid");
    if (error) throw new Error(error.message);
    return;
  }

  const { error: rpcError } = await admin.rpc("service_confirm_subscription_status", {
    target_subscription_id: row.id,
    target_status: status,
    target_provider_status: providerStatus,
    target_effective_at: options?.effectiveAt ?? null,
    target_provider_event_id: event.id,
    target_provider_event_at: eventAt,
    target_error_code: status === "past_due" ? "payment_failed" : null
  });
  if (rpcError) throw new Error(rpcError.message);

  const providerFields: Record<string, unknown> = {
    provider_customer_id: options?.customerId ?? row.provider_customer_id,
    provider_subscription_id: options?.subscriptionId ?? row.provider_subscription_id,
    updated_at: new Date().toISOString()
  };
  if (options?.currentPeriodEnd !== undefined) providerFields.current_period_end = options.currentPeriodEnd;
  if (status === "active" || status === "trialing") providerFields.checkout_url = null;

  const { error: updateError } = await admin.from("organization_subscriptions").update(providerFields).eq("id", row.id).eq("access_mode", "paid");
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
  await applyProviderStatus(row, event, providerStatus, { customerId, subscriptionId });

  const admin = createSupabaseAdminClient();
  const accessRequestId = metadata ? stringValue(metadata.access_request_id) : null;
  if (accessRequestId) await admin.from("access_requests").update({ billing_checkout_url: null }).eq("id", accessRequestId);
}

async function handleSubscription(event: StripeEvent, subscription: Record<string, unknown>) {
  const metadata = objectValue(subscription.metadata);
  const organizationId = metadata ? stringValue(metadata.organization_id) : null;
  const subscriptionId = stringValue(subscription.id);
  const customerId = stringValue(subscription.customer);
  const row = await findSubscription({ organizationId, subscriptionId, customerId });
  if (!row) return;

  const providerStatus = event.type === "customer.subscription.deleted" ? "canceled" : stringValue(subscription.status);
  const pauseCollection = objectValue(subscription.pause_collection);
  const localStatus = resolveLocalSubscriptionStatus(providerStatus, Boolean(pauseCollection));
  await applyProviderStatus(row, event, providerStatus, {
    localStatus,
    effectiveAt: localStatus === "paused" ? new Date().toISOString() : null,
    currentPeriodEnd: unixDate(subscription.current_period_end),
    customerId,
    subscriptionId
  });

  const cancelAtPeriodEnd = subscription.cancel_at_period_end === true;
  const currentIntent: TerminationIntent = row.termination_intent === "cancel" || row.termination_intent === "auto_renew_off" ? row.termination_intent : null;
  const requestedAction: RenewalAction = row.renewal_action_requested === "cancel" || row.renewal_action_requested === "disable_auto_renew" || row.renewal_action_requested === "reactivate" ? row.renewal_action_requested : null;
  const renewal = reconcileRenewalConfirmation({ cancelAtPeriodEnd, localStatus, currentIntent, requestedAction });

  const update: Record<string, unknown> = {
    cancel_at_period_end: cancelAtPeriodEnd,
    termination_intent: renewal.terminationIntent,
    pause_collection_behavior: pauseCollection ? stringValue(pauseCollection.behavior) : null,
    canceled_at: unixDate(subscription.canceled_at),
    updated_at: new Date().toISOString()
  };
  if (renewal.clearRequestedAction) {
    update.renewal_action_requested = null;
    update.renewal_action_requested_at = null;
    update.renewal_action_requested_by = null;
  }
  if (renewal.terminationIntent !== "cancel") update.cancellation_reason = null;

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("organization_subscriptions").update(update).eq("id", row.id).eq("access_mode", "paid");
  if (error) throw new Error(error.message);
}

async function handleInvoice(event: StripeEvent, invoice: Record<string, unknown>) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  const customerId = stringValue(invoice.customer);
  const row = await findSubscription({ subscriptionId, customerId });
  if (!row) return;

  if (event.type === "invoice.paid" && !shouldApplyPaidInvoiceAsActive(row.status)) return;
  const providerStatus = event.type === "invoice.paid" ? "active" : "past_due";
  await applyProviderStatus(row, event, providerStatus, { customerId, subscriptionId });
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
