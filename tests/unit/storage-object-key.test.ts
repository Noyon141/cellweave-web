import { describe, it, expect } from "vitest";
import {
  normalizeSafeFileName,
  buildDatasetSourceObjectKey,
  buildCanonicalDatasetKey,
} from "@/server/integrations/storage/object-key";
import { StorageError } from "@/server/integrations/storage/storage-types";

describe("Object Key & Safe File Name Security (Step E)", () => {
  describe("normalizeSafeFileName", () => {
    it("safely preserves ordinary scientific dataset file names", () => {
      expect(normalizeSafeFileName("sample.h5ad")).toBe("sample.h5ad");
      expect(normalizeSafeFileName("matrix.mtx.gz")).toBe("matrix.mtx.gz");
      expect(normalizeSafeFileName("features.tsv.gz")).toBe("features.tsv.gz");
      expect(normalizeSafeFileName("barcodes.tsv.gz")).toBe("barcodes.tsv.gz");
      expect(normalizeSafeFileName("counts.csv")).toBe("counts.csv");
    });

    it("rejects directory traversal attempts with .. in path or name", () => {
      expect(() => normalizeSafeFileName("../evil.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("..\\evil.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("subdir/../../evil.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("..")).toThrow(StorageError);
      expect(() => normalizeSafeFileName(".")).toThrow(StorageError);
    });

    it("rejects absolute Unix and Windows paths", () => {
      expect(() => normalizeSafeFileName("/etc/passwd")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("C:\\Windows\\system32\\calc.exe")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("D:/data/matrix.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("\\\\server\\share\\data.h5ad")).toThrow(StorageError);
    });

    it("rejects control and NUL characters", () => {
      expect(() => normalizeSafeFileName("file\0.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("file\r\n.h5ad")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("file\x07.h5ad")).toThrow(StorageError);
    });

    it("rejects empty or whitespace-only file names", () => {
      expect(() => normalizeSafeFileName("")).toThrow(StorageError);
      expect(() => normalizeSafeFileName("   ")).toThrow(StorageError);
    });

    it("strips safe subdirectory paths if present without traversal to yield basename", () => {
      expect(normalizeSafeFileName("subfolder/data.h5ad")).toBe("data.h5ad");
      expect(normalizeSafeFileName("nested\\folder\\matrix.mtx.gz")).toBe("matrix.mtx.gz");
    });

    it("rejects file names exceeding maximum length", () => {
      const veryLong = "a".repeat(256) + ".h5ad";
      expect(() => normalizeSafeFileName(veryLong)).toThrow(StorageError);
    });
  });

  describe("buildDatasetSourceObjectKey", () => {
    it("builds the exact canonical source object key format", () => {
      const key = buildDatasetSourceObjectKey({
        organizationId: "org_123",
        projectId: "proj_456",
        datasetVersionId: "dsv_789",
        fileName: "matrix.h5ad",
      });

      expect(key).toBe("org/org_123/project/proj_456/datasets/dsv_789/source/matrix.h5ad");
    });

    it("prevents traversal escaping the source prefix via malicious fileName", () => {
      expect(() =>
        buildDatasetSourceObjectKey({
          organizationId: "org_123",
          projectId: "proj_456",
          datasetVersionId: "dsv_789",
          fileName: "../../../escaped.h5ad",
        })
      ).toThrow(StorageError);
    });

    it("prevents path separator injection inside organizationId", () => {
      expect(() =>
        buildDatasetSourceObjectKey({
          organizationId: "org_123/other",
          projectId: "proj_456",
          datasetVersionId: "dsv_789",
          fileName: "data.h5ad",
        })
      ).toThrow(StorageError);
    });

    it("prevents path separator injection inside projectId", () => {
      expect(() =>
        buildDatasetSourceObjectKey({
          organizationId: "org_123",
          projectId: "proj_456\\attack",
          datasetVersionId: "dsv_789",
          fileName: "data.h5ad",
        })
      ).toThrow(StorageError);
    });

    it("prevents path separator injection inside datasetVersionId", () => {
      expect(() =>
        buildDatasetSourceObjectKey({
          organizationId: "org_123",
          projectId: "proj_456",
          datasetVersionId: "dsv_789/evil",
          fileName: "data.h5ad",
        })
      ).toThrow(StorageError);
    });
  });

  describe("buildCanonicalDatasetKey", () => {
    it("builds the exact canonical artifact key format and uses projectId (never datasetId)", () => {
      const key = buildCanonicalDatasetKey({
        organizationId: "org_alpha",
        projectId: "prj_real_123",
        datasetVersionId: "dsv_789",
      });

      expect(key).toBe(
        "org/org_alpha/project/prj_real_123/datasets/dsv_789/canonical/canonical.h5ad"
      );
      expect(key).toContain("prj_real_123");
      expect(key).not.toContain("ds_wrong_456");
    });

    it("rejects empty, whitespace, control, or traversal characters in identifiers", () => {
      for (const badId of [
        "",
        "   ",
        "id/evil",
        "id\\evil",
        "..",
        "id..2",
        "id with space",
        "id\0null",
      ]) {
        expect(() =>
          buildCanonicalDatasetKey({
            organizationId: badId,
            projectId: "prj_123",
            datasetVersionId: "dsv_789",
          })
        ).toThrow(StorageError);

        expect(() =>
          buildCanonicalDatasetKey({
            organizationId: "org_123",
            projectId: badId,
            datasetVersionId: "dsv_789",
          })
        ).toThrow(StorageError);

        expect(() =>
          buildCanonicalDatasetKey({
            organizationId: "org_123",
            projectId: "prj_123",
            datasetVersionId: badId,
          })
        ).toThrow(StorageError);
      }
    });
  });
});
