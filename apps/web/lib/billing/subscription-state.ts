export type LocalSubscriptionStatus = "inactive" | "trialing" | "active" | "paused" | "past_due" | "canceled";
export type RenewalAction = "cancel" | "disable_auto_renew" | "reactivate" | null;
export type TerminationIntent = "cancel" | "auto_renew_off" | null;

export function mapStripeSubscriptionStatus(status: string | null): LocalSubscriptionStatus {
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "past_due" || status === "unpaid") return "past_due";
  if (status === "paused") return "paused";
  if (status === "canceled" || status === "incomplete_expired") return "canceled";
  return "inactive";
}

export function resolveLocalSubscriptionStatus(providerStatus: string | null, pauseCollectionPresent: boolean): LocalSubscriptionStatus {
  const mapped = mapStripeSubscriptionStatus(providerStatus);
  if (pauseCollectionPresent && (mapped === "active" || mapped === "trialing")) return "paused";
  return mapped;
}

export function shouldApplyPaidInvoiceAsActive(currentStatus: string) {
  return currentStatus !== "paused";
}

export function reconcileRenewalConfirmation(input: {
  cancelAtPeriodEnd: boolean;
  localStatus: LocalSubscriptionStatus;
  currentIntent: TerminationIntent;
  requestedAction: RenewalAction;
}) {
  let terminationIntent = input.currentIntent;
  let clearRequestedAction = false;

  if (input.localStatus === "canceled") {
    terminationIntent = terminationIntent ?? "cancel";
    clearRequestedAction = true;
  } else if (input.cancelAtPeriodEnd) {
    if (input.requestedAction === "cancel") {
      terminationIntent = "cancel";
      clearRequestedAction = true;
    } else if (input.requestedAction === "disable_auto_renew") {
      terminationIntent = "auto_renew_off";
      clearRequestedAction = true;
    } else {
      terminationIntent = terminationIntent ?? "cancel";
    }
  } else {
    terminationIntent = null;
    if (input.requestedAction === "reactivate") clearRequestedAction = true;
  }

  return { terminationIntent, clearRequestedAction };
}
