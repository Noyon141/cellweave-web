import type { OrganizationId } from "@/types";

export interface CreateCheckoutParams {
  readonly organizationId: OrganizationId;
  readonly planId: string;
  readonly returnUrl: string;
  readonly customerEmail?: string;
}

export interface CheckoutSession {
  readonly checkoutUrl: string;
  readonly sessionId: string;
}

export interface SubscriptionInfo {
  readonly subscriptionId: string;
  readonly status: "active" | "past_due" | "canceled" | "incomplete";
  readonly planId: string;
  readonly currentPeriodEnd?: Date;
}

export interface ReportUsageParams {
  readonly organizationId: OrganizationId;
  readonly idempotencyKey: string;
  readonly computeCredits: number;
  readonly timestamp: Date;
}

export interface CustomerPortalParams {
  readonly organizationId: OrganizationId;
  readonly returnUrl: string;
}

/**
 * Billing Provider Abstraction (System Design §123)
 * Protects domain services from commercial billing provider coupling.
 */
export interface BillingProvider {
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutSession>;
  getSubscription(organizationId: OrganizationId): Promise<SubscriptionInfo | null>;
  reportUsage(params: ReportUsageParams): Promise<{ readonly acknowledged: boolean }>;
  customerPortal(params: CustomerPortalParams): Promise<{ readonly url: string }>;
}
