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

/**
 * Polar Billing Provider (Phase 0 Structural Scaffold)
 * Encapsulates the BillingProvider boundary.
 * Live checkout, usage metering, and billing synchronization activate in Phase 11.
 */
export class PolarBillingProvider implements BillingProvider {
  private readonly accessToken: string;

  constructor(accessToken: string = env.POLAR_ACCESS_TOKEN) {
    this.accessToken = accessToken;
  }

  async createCheckout(_params: CreateCheckoutParams): Promise<CheckoutSession> {
    throw new Error("Polar checkout integration activates in Phase 11");
  }

  async getSubscription(_organizationId: OrganizationId): Promise<SubscriptionInfo | null> {
    return null;
  }

  async reportUsage(_params: ReportUsageParams): Promise<{ readonly acknowledged: boolean }> {
    throw new Error("Polar usage reporting activates in Phase 11");
  }

  async customerPortal(_params: CustomerPortalParams): Promise<{ readonly url: string }> {
    throw new Error("Polar customer portal activates in Phase 11");
  }
}

let polarInstance: PolarBillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (!polarInstance) {
    polarInstance = new PolarBillingProvider();
  }
  return polarInstance;
}
