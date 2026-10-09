import { describe, it, expect } from "vitest";
import { getHealthService } from "@/server/application/health-service";

describe("HealthService", () => {
  it("returns ok status and phase 0 foundation details", () => {
    const service = getHealthService();
    const status = service.getHealthStatus();

    expect(status.status).toBe("ok");
    expect(status.phase).toBe("Phase 0 — Foundations");
    expect(status.service).toBe("cellweave-web");
    expect(status.version).toBe("0.1.0");
    expect(status.ruo).toBe(true);
    expect(new Date(status.timestamp).getTime()).not.toBeNaN();
  });
});
