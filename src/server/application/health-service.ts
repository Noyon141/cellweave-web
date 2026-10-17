import { neon } from "@neondatabase/serverless";
import { env } from "../config/env";

export interface DatabaseHealthInfo {
  readonly status: "connected" | "disconnected" | "unconfigured";
  readonly user?: string;
  readonly database?: string;
  readonly error?: string;
}

export interface StorageHealthInfo {
  readonly provider: "R2";
  readonly bucket: string;
}

export interface OrchestrationHealthInfo {
  readonly provider: "Temporal";
  readonly namespace: string;
  readonly address: string;
}

export interface HealthStatus {
  readonly status: "ok" | "degraded";
  readonly phase: "Phase 1 — Identity & Tenancy";
  readonly service: "cellweave-web";
  readonly version: string;
  readonly timestamp: string;
  readonly ruo: true;
  readonly database?: DatabaseHealthInfo;
  readonly storage?: StorageHealthInfo;
  readonly orchestration?: OrchestrationHealthInfo;
}

export class HealthService {
  async getHealthStatus(): Promise<HealthStatus> {
    let dbInfo: DatabaseHealthInfo = { status: "unconfigured" };

    if (env.DATABASE_URL) {
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql("SELECT current_user, current_database()");
        const first = rows[0];
        if (
          first &&
          typeof first === "object" &&
          "current_user" in first &&
          "current_database" in first &&
          typeof first.current_user === "string" &&
          typeof first.current_database === "string"
        ) {
          dbInfo = {
            status: "connected",
            user: first.current_user,
            database: first.current_database,
          };
        }
      } catch (err) {
        dbInfo = {
          status: "disconnected",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const storageInfo: StorageHealthInfo = {
      provider: "R2",
      bucket: env.R2_BUCKET_NAME,
    };

    const orchestrationInfo: OrchestrationHealthInfo = {
      provider: "Temporal",
      namespace: env.TEMPORAL_NAMESPACE,
      address: env.TEMPORAL_ADDRESS,
    };

    return {
      status: "ok",
      phase: "Phase 1 — Identity & Tenancy",
      service: "cellweave-web",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      ruo: true,
      database: dbInfo,
      storage: storageInfo,
      orchestration: orchestrationInfo,
    };
  }
}

let healthServiceInstance: HealthService | null = null;

export function getHealthService(): HealthService {
  if (!healthServiceInstance) {
    healthServiceInstance = new HealthService();
  }
  return healthServiceInstance;
}
