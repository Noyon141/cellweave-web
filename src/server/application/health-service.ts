export interface HealthStatus {
  readonly status: "ok" | "degraded";
  readonly phase: "Phase 0 — Foundations";
  readonly service: "cellweave-web";
  readonly version: string;
  readonly timestamp: string;
  readonly ruo: true;
}

export class HealthService {
  getHealthStatus(): HealthStatus {
    return {
      status: "ok",
      phase: "Phase 0 — Foundations",
      service: "cellweave-web",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      ruo: true,
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
