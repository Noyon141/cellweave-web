import type {
  BillingProvider,
  CreateCheckoutParams,
  CheckoutSession,
  SubscriptionInfo,
  ReportUsageParams,
  CustomerPortalParams,
} from "./billing-provider";
import type { OrganizationId } from "@/types";
import { env } from "@/server/config/env";

export class PolarBillingProvider implements BillingProvider {
  private readonly accessToken: string;

  constructor(accessToken: string = env.POLAR_ACCESS_TOKEN) {
    this.accessToken = accessToken;
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutSession> {
    // Adapter boundary implementation (Phase 0 Foundation)
    return {
      checkoutUrl: `https://sandbox.polar.sh/checkout?org=${params.organizationId}&plan=${params.planId}`,
      sessionId: `sess_${params.organizationId}_${Date.now()}`,
    };
  }

  async getSubscription(_organizationId: OrganizationId): Promise<SubscriptionInfo | null> {
    // Adapter boundary implementation (Phase 0 Foundation)
    return null;
  }

  async reportUsage(_params: ReportUsageParams): Promise<{ readonly acknowledged: boolean }> {
    // Adapter boundary implementation (Phase 0 Foundation)
    return { acknowledged: true };
  }

  async customerPortal(params: CustomerPortalParams): Promise<{ readonly url: string }> {
    // Adapter boundary implementation (Phase 0 Foundation)
    return { url: `${params.returnUrl}?portal=active` };
  }
}

let polarInstance: PolarBillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (!polarInstance) {
    polarInstance = new PolarBillingProvider();
  }
  return polarInstance;
}
