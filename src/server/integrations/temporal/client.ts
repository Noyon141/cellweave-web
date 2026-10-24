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
      if (process.env.CELLWEAVE_ENVIRONMENT !== "local") {
        if (
          !process.env.TEMPORAL_ADDRESS ||
          !process.env.TEMPORAL_NAMESPACE ||
          !process.env.TEMPORAL_TASK_QUEUE ||
          (!env.TEMPORAL_API_KEY && !(env.TEMPORAL_CLIENT_CERT && env.TEMPORAL_CLIENT_KEY)) ||
          env.TEMPORAL_NAMESPACE === "default" ||
          /localhost|127\.0\.0\.1/.test(env.TEMPORAL_ADDRESS)
        )
          throw new Error("Explicit Temporal configuration required");
      }
      if (Boolean(env.TEMPORAL_CLIENT_CERT) !== Boolean(env.TEMPORAL_CLIENT_KEY))
        throw new Error("Incomplete Temporal certificate configuration");
      const tlsConfig = env.TEMPORAL_CLIENT_CERT
        ? {
            clientCertPair: {
              crt: Buffer.from(env.TEMPORAL_CLIENT_CERT, "utf-8"),
              key: Buffer.from(env.TEMPORAL_CLIENT_KEY ?? "", "utf-8"),
            },
          }
        : env.TEMPORAL_API_KEY
          ? true
          : undefined;

      const connection = await Connection.connect({
        address: env.TEMPORAL_ADDRESS,
        apiKey: env.TEMPORAL_API_KEY,
        tls: tlsConfig,
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
