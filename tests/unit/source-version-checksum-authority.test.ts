import { describe, expect, it, vi } from "vitest";
import { DatasetService, createDatasetVersionSchema } from "@/server/services/dataset-service";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/server/database/client", () => ({ getDb: () => ({ transaction: mocks.transaction }) }));
vi.mock("@/server/integrations/auth/better-auth", () => ({ auth: { api: {} } }));

describe("dataset version source-checksum authority", () => {
  it.each(["a".repeat(64), "", null, 123])(
    "rejects sourceChecksum at the public version-creation boundary: %s",
    async (sourceChecksum) => {
      const input = { sourceFormat: "H5AD", sourceChecksum };
      expect(createDatasetVersionSchema.safeParse(input).success).toBe(false);
      const service = new DatasetService();
      await expect(
        Reflect.apply(service.createDatasetVersion, service, [
          { organizationId: "org", userId: "user", role: "scientist" },
          "dataset",
          input,
        ])
      ).rejects.toThrow();
      expect(mocks.transaction).not.toHaveBeenCalled();
    }
  );

  it("allows version creation without a caller checksum", () => {
    expect(createDatasetVersionSchema.safeParse({ sourceFormat: "H5AD" }).success).toBe(true);
  });
});
