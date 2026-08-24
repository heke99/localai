import { describe, expect, it } from "vitest";
import {
  reconcileRenewalConfirmation,
  resolveLocalSubscriptionStatus,
  shouldApplyPaidInvoiceAsActive
} from "./subscription-state";

describe("subscription state reconciliation", () => {
  it("treats Stripe pause_collection as locally paused while preserving provider active semantics", () => {
    expect(resolveLocalSubscriptionStatus("active", true)).toBe("paused");
    expect(resolveLocalSubscriptionStatus("trialing", true)).toBe("paused");
    expect(resolveLocalSubscriptionStatus("past_due", true)).toBe("past_due");
  });

  it("does not let invoice.paid implicitly resume a locally paused subscription", () => {
    expect(shouldApplyPaidInvoiceAsActive("paused")).toBe(false);
    expect(shouldApplyPaidInvoiceAsActive("past_due")).toBe(true);
  });

  it("distinguishes cancellation from disabling auto-renew on provider confirmation", () => {
    expect(reconcileRenewalConfirmation({
      cancelAtPeriodEnd: true,
      localStatus: "active",
      currentIntent: null,
      requestedAction: "cancel"
    })).toEqual({ terminationIntent: "cancel", clearRequestedAction: true });

    expect(reconcileRenewalConfirmation({
      cancelAtPeriodEnd: true,
      localStatus: "active",
      currentIntent: null,
      requestedAction: "disable_auto_renew"
    })).toEqual({ terminationIntent: "auto_renew_off", clearRequestedAction: true });
  });

  it("clears termination intent only after auto-renew is provider-confirmed active again", () => {
    expect(reconcileRenewalConfirmation({
      cancelAtPeriodEnd: false,
      localStatus: "active",
      currentIntent: "cancel",
      requestedAction: "reactivate"
    })).toEqual({ terminationIntent: null, clearRequestedAction: true });
  });
});
