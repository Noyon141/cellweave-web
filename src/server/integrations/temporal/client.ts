import { Connection, Client, type ClientOptions } from "@temporalio/client";
import { env } from "@/server/config/env";

export interface TemporalWorkflowStartOptions {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly taskQueue: string;
  readonly args: readonly unknown[];
}

/**
 * Temporal Client Integration Boundary (System Design §36–38)
 * Next.js serves strictly as a client to Temporal Cloud.
 * Workflow definitions and execution belong in cellweave-orchestrator.
 */
export class TemporalClientService {
  private client: Client | null = null;

  async getClient(): Promise<Client> {
    if (!this.client) {
      const connection = await Connection.connect({
        address: env.TEMPORAL_ADDRESS,
        tls: env.TEMPORAL_CLIENT_CERT
          ? {
              clientCertPair: {
                crt: Buffer.from(env.TEMPORAL_CLIENT_CERT, "utf-8"),
                key: Buffer.from(env.TEMPORAL_CLIENT_KEY ?? "", "utf-8"),
              },
            }
          : undefined,
      });

      const options: ClientOptions = {
        namespace: env.TEMPORAL_NAMESPACE,
      };

      this.client = new Client({
        connection,
        ...options,
      });
    }
    return this.client;
  }

  buildDeterministicRunWorkflowId(analysisRunId: string): string {
    return `analysis-run:${analysisRunId}`;
  }
}

let temporalServiceInstance: TemporalClientService | null = null;

export function getTemporalClientService(): TemporalClientService {
  if (!temporalServiceInstance) {
    temporalServiceInstance = new TemporalClientService();
  }
  return temporalServiceInstance;
}
