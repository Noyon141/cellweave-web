import { describe, it, expect } from "vitest";
import type { QcReviewView, QcSelectionParameters } from "@cellweave/contracts";
import { canConfirmQc, sameQcSelection } from "@/lib/qc-review";
import { qcSelectionChecksum } from "@/server/services/qc-checksum";
import {
  validQcStartRequest,
  validQcApprovalRequest,
} from "@/server/services/execution-validation";
const selection: QcSelectionParameters = { thresholds: [], doubletHandling: "RETAIN" };
const view: QcReviewView = {
  analysisRunId: "run",
  datasetVersionId: "version",
  qcRevision: 1,
  status: "QC_REVIEW_REQUIRED",
  canApprove: true,
  summary: null,
  preview: {
    previewId: "preview",
    qcRevision: 1,
    canonicalChecksum: "a".repeat(64),
    parametersChecksum: "b".repeat(64),
    selectionArtifactId: "mask",
    selectionChecksum: "c".repeat(64),
    includedCount: 2,
    excludedCount: 1,
  },
  previewParameters: selection,
  previewPending: false,
  previewError: null,
  decision: null,
  filteredArtifactId: null,
};
describe("QC review authority", () => {
  it("binds browser confirmation to the exact current trusted preview", () => {
    expect(canConfirmQc(view, selection)).toBe(true);
    expect(canConfirmQc(view, { ...selection, doubletHandling: "EXCLUDE_PREDICTED" })).toBe(false);
    expect(canConfirmQc({ ...view, previewPending: true }, selection)).toBe(false);
    expect(canConfirmQc({ ...view, canApprove: false }, selection)).toBe(false);
    expect(canConfirmQc({ ...view, status: "CANCEL_REQUESTED" }, selection)).toBe(false);
    expect(sameQcSelection(selection, null)).toBe(false);
  });
  it("uses fixed cross-language scientific parameter digest vectors", () => {
    expect(qcSelectionChecksum(selection)).toBe(
      "d3172e332d9bd32c07ee170649e7294fd44004a90c8762d69c5d880a66f27277"
    );
    expect(
      qcSelectionChecksum({
        thresholds: [{ metric: "total_counts", minimum: 1, maximum: null, sampleKey: null }],
        doubletHandling: "RETAIN",
      })
    ).toBe("7c25f0ab7d1be36f8f8a4ada2c214eb5387115b5f69d889b3281dc4a2621bd6e");
  });
  it.each([
    "organizationId",
    "canonicalChecksum",
    "sourceChecksum",
    "cellCount",
    "r2Key",
    "actorId",
  ])("rejects browser authority extension %s", (field) => {
    expect(
      validQcStartRequest({
        datasetVersionId: "version",
        captureBindings: [],
        wholeInputSampleId: null,
        [field]: "forged",
      })
    ).toBe(false);
    expect(
      validQcApprovalRequest({ previewId: "preview", reason: "Reviewed", [field]: "forged" })
    ).toBe(false);
  });
});
